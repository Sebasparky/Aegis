import type { FastifyInstance } from "fastify";
import type { AegisVaultPass, AegisPassKind } from "@aegis/types";
import { MOCK_USER_ID, newId } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import { getKmsProvider, type KmsContext } from "../lib/kms.js";
import { getVaultRepository } from "../repositories/vaultRepository.js";

interface CreateVaultPassBody {
  label: string;
  kind: AegisPassKind;
  domain: string;
  username: string;
  password: string;
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

    let blob;
    try {
      const kms = getKmsProvider();
      const kmsContext: KmsContext = {
        user_id: MOCK_USER_ID,
        pass_id,
        domain: domain.trim(),
        purpose: "login_password",
      };
      blob = await kms.encryptSecret(password, kmsContext);
    } catch (err) {
      console.error("[vault-passes] Encryption failed:", err);
      return reply.status(500).send({ ok: false, error: { code: "KMS_ERROR", message: "Failed to encrypt credential. Check KMS configuration." } });
    }

    try {
      await getVaultRepository().createVaultPass(pass, blob);
    } catch (err) {
      console.error("[vault-passes] Repository createVaultPass failed:", err);
      return reply.status(500).send({ ok: false, error: { code: "STORAGE_ERROR", message: "Failed to store credential." } });
    }

    schedulePersist();

    return reply.status(201).send({ ok: true, data: await toView(pass) });
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
