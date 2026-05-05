import type { FastifyInstance } from "fastify";
import type { AegisVaultPass, AegisPassKind } from "@aegis/types";
import { MOCK_USER_ID, newId } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import { getKmsProvider, type KmsContext } from "../lib/kms.js";
import { getVaultRepository } from "../repositories/vaultRepository.js";
import { recordKmsAuditEvent } from "../lib/kmsAudit.js";

interface CreateVaultPassBody {
  label: string;
  kind: AegisPassKind;
  domain: string;
  username: string;
  password: string;
}

interface ImportVaultPassesBody {
  credentials: Array<{
    label: string;
    kind: AegisPassKind;
    domain: string;
    username: string;
    password: string;
  }>;
}

// Metadata shape returned to the UI — never includes password or raw secret.
interface VaultPassView {
  pass_id: string;
  user_id: string;
  label: string;
  kind: AegisPassKind;
  domain: string;
  username?: string;
  created_at: string;
  updated_at: string;
  has_password: boolean;
}

async function toView(pass: AegisVaultPass): Promise<VaultPassView> {
  return {
    pass_id: pass.pass_id,
    user_id: pass.user_id,
    label: pass.label,
    kind: pass.kind,
    domain: pass.domain,
    username: pass.username,
    created_at: pass.created_at,
    updated_at: pass.updated_at,
    has_password: await getVaultRepository().hasEncryptedSecret(pass.secret_ref),
  };
}

// Shared creation path used by both single and bulk import endpoints.
// Password is encrypted and stored via KMS; plaintext is never persisted.
type CreateOneResult = { ok: true; pass: AegisVaultPass } | { ok: false; error: string };

async function createAndStoreVaultPass(params: {
  label: string;
  kind: AegisPassKind;
  domain: string;
  username: string;
  password: string;
}): Promise<CreateOneResult> {
  const { label, kind, domain, username, password } = params;
  const now = new Date().toISOString();
  const pass_id = newId("pass_vault");
  const secret_ref = `devvault://${pass_id}/password`;

  const pass: AegisVaultPass = {
    pass_id,
    user_id: MOCK_USER_ID,
    label: label.trim(),
    kind,
    domain: domain.trim(),
    username: username.trim(),
    secret_ref,
    created_at: now,
    updated_at: now,
  };

  const kms = getKmsProvider();
  const kmsContext: KmsContext = {
    user_id: MOCK_USER_ID,
    pass_id,
    domain: domain.trim(),
    purpose: "login_password",
  };

  let blob;
  try {
    blob = await kms.encryptSecret(password, kmsContext);
    recordKmsAuditEvent({
      operation: "encrypt_secret",
      provider: kms.provider,
      user_id: MOCK_USER_ID,
      pass_id,
      domain: domain.trim(),
      success: true,
    });
  } catch (err) {
    recordKmsAuditEvent({
      operation: "encrypt_secret",
      provider: kms.provider,
      user_id: MOCK_USER_ID,
      pass_id,
      domain: domain.trim(),
      success: false,
      error_code: err instanceof Error ? err.message.split(":")[0] : "KMS_ERROR",
    });
    console.error("[vault-passes] Encryption failed:", err);
    return { ok: false, error: "KMS_ERROR" };
  }

  try {
    await getVaultRepository().createVaultPass(pass, blob);
  } catch (err) {
    console.error("[vault-passes] Repository createVaultPass failed:", err);
    return { ok: false, error: "STORAGE_ERROR" };
  }

  return { ok: true, pass };
}

export async function vaultPassRoutes(server: FastifyInstance) {
  /**
   * GET /api/vault-passes
   * List all vault passes for the current user.
   * Never returns password or secret_ref value.
   */
  server.get("/api/vault-passes", async () => {
    const passes = await getVaultRepository().listVaultPasses(MOCK_USER_ID);
    const result = await Promise.all(
      passes.sort((a, b) => a.created_at.localeCompare(b.created_at)).map(toView)
    );
    return { ok: true, data: result };
  });

  /**
   * POST /api/vault-passes
   * Create a login_password credential bundle.
   * Stores metadata and the encrypted secret via the vault repository.
   * Password is never returned after this response.
   */
  server.post<{ Body: CreateVaultPassBody }>("/api/vault-passes", async (req, reply) => {
    const { label, kind, domain, username, password } = req.body ?? {};

    if (!label?.trim())
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "label is required." } });
    if (kind !== "login_password")
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "kind must be login_password for v1." } });
    if (!domain?.trim())
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "domain is required." } });
    if (!username?.trim())
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "username is required for login_password." } });
    if (!password)
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "password is required for login_password." } });

    const result = await createAndStoreVaultPass({ label, kind, domain, username, password });
    if (!result.ok) {
      const msg = result.error === "KMS_ERROR"
        ? "Failed to encrypt credential. Check KMS configuration."
        : "Failed to store credential.";
      return reply.status(500).send({ ok: false, error: { code: result.error, message: msg } });
    }

    schedulePersist();
    return reply.status(201).send({ ok: true, data: await toView(result.pass) });
  });

  /**
   * POST /api/internal/vault-passes/import
   * Bulk import credentials from a CSV export.
   * Each entry is validated and encrypted individually via the same KMS path as single creation.
   * Passwords are never persisted — raw values exist only during this request.
   * Returns only safe metadata; partial success is allowed.
   */
  server.post<{ Body: ImportVaultPassesBody }>("/api/internal/vault-passes/import", async (req, reply) => {
    const { credentials } = req.body ?? {};

    if (!Array.isArray(credentials) || credentials.length === 0)
      return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "credentials must be a non-empty array." } });
    if (credentials.length > 200)
      return reply.status(400).send({ ok: false, error: { code: "IMPORT_LIMIT_EXCEEDED", message: "Maximum 200 credentials per import request." } });

    const imported: VaultPassView[] = [];
    const failed: Array<{ index: number; reason: string }> = [];

    for (let i = 0; i < credentials.length; i++) {
      const c = credentials[i];
      if (!c.label?.trim() || !c.domain?.trim() || !c.username?.trim() || !c.password || c.kind !== "login_password") {
        failed.push({ index: i, reason: "VALIDATION_ERROR" });
        continue;
      }
      const result = await createAndStoreVaultPass(c);
      if (result.ok) {
        imported.push(await toView(result.pass));
      } else {
        failed.push({ index: i, reason: result.error });
      }
    }

    schedulePersist();

    return {
      ok: true,
      data: {
        imported,
        failed,
        total_requested: credentials.length,
        total_imported: imported.length,
      },
    };
  });

  /**
   * DELETE /api/vault-passes/:passId
   * Delete a vault pass and its corresponding secret.
   */
  server.delete<{ Params: { passId: string } }>("/api/vault-passes/:passId", async (req, reply) => {
    const pass = await getVaultRepository().getVaultPass(req.params.passId);
    if (!pass || pass.user_id !== MOCK_USER_ID) {
      return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Vault pass not found." } });
    }

    await getVaultRepository().deleteVaultPass(pass.pass_id);
    schedulePersist();

    return { ok: true };
  });
}
