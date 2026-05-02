import type { AegisVaultPass } from "@aegis/types";
import { getPersistenceProvider } from "../lib/persistenceProvider.js";
import { getSupabaseAdminClient } from "../lib/supabase.js";
import type { EncryptedSecretBlob } from "../lib/kms.js";
import {
  aegisVaultPasses,
  encryptedSecretVault,
} from "../store/index.js";

// ─── Interface ────────────────────────────────────────────────────────────────

export interface VaultRepository {
  listVaultPasses(userId: string): Promise<AegisVaultPass[]>;
  getVaultPass(passId: string): Promise<AegisVaultPass | undefined>;
  // Creates vault pass metadata and its encrypted secret atomically.
  createVaultPass(pass: AegisVaultPass, blob: EncryptedSecretBlob): Promise<void>;
  deleteVaultPass(passId: string): Promise<void>;
  hasEncryptedSecret(secretRef: string): Promise<boolean>;
  getEncryptedSecret(secretRef: string): Promise<EncryptedSecretBlob | undefined>;
}

// ─── Local (Map) Implementation ───────────────────────────────────────────────

class LocalVaultRepository implements VaultRepository {
  async listVaultPasses(userId: string): Promise<AegisVaultPass[]> {
    return Array.from(aegisVaultPasses.values()).filter((p) => p.user_id === userId);
  }

  async getVaultPass(passId: string): Promise<AegisVaultPass | undefined> {
    return aegisVaultPasses.get(passId);
  }

  async createVaultPass(pass: AegisVaultPass, blob: EncryptedSecretBlob): Promise<void> {
    aegisVaultPasses.set(pass.pass_id, pass);
    encryptedSecretVault.set(pass.secret_ref, blob);
  }

  async deleteVaultPass(passId: string): Promise<void> {
    const pass = aegisVaultPasses.get(passId);
    if (pass) encryptedSecretVault.delete(pass.secret_ref);
    aegisVaultPasses.delete(passId);
  }

  async hasEncryptedSecret(secretRef: string): Promise<boolean> {
    return encryptedSecretVault.has(secretRef);
  }

  async getEncryptedSecret(secretRef: string): Promise<EncryptedSecretBlob | undefined> {
    return encryptedSecretVault.get(secretRef);
  }
}

// ─── Supabase Implementation ──────────────────────────────────────────────────
// Dual-writes to local Maps after each Supabase write so that non-migrated
// routes (credential-sessions.ts, route-runs.ts pass validation) can continue
// reading from Maps without modification.
//
// TODO (long-term): remove dual-write once all vault/secret reads are migrated
// to use getVaultRepository(). Maps will then become a pure in-process cache
// populated only on startup via loadStore().

class SupabaseVaultRepository implements VaultRepository {
  private get sb() {
    return getSupabaseAdminClient();
  }

  async listVaultPasses(userId: string): Promise<AegisVaultPass[]> {
    const { data, error } = await this.sb
      .from("aegis_vault_passes")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(`[supabase/vaultPasses.list] ${error.message}`);
    return (data ?? []).map(rowToVaultPass);
  }

  async getVaultPass(passId: string): Promise<AegisVaultPass | undefined> {
    const { data, error } = await this.sb
      .from("aegis_vault_passes")
      .select("*")
      .eq("pass_id", passId)
      .maybeSingle();
    if (error) throw new Error(`[supabase/vaultPasses.get] ${error.message}`);
    return data ? rowToVaultPass(data) : undefined;
  }

  async createVaultPass(pass: AegisVaultPass, blob: EncryptedSecretBlob): Promise<void> {
    const { error: e1 } = await this.sb.from("aegis_vault_passes").upsert(
      {
        pass_id:    pass.pass_id,
        user_id:    pass.user_id,
        label:      pass.label,
        kind:       pass.kind,
        domain:     pass.domain,
        username:   pass.username ?? null,
        secret_ref: pass.secret_ref,
        created_at: pass.created_at,
        updated_at: pass.updated_at,
      },
      { onConflict: "pass_id" }
    );
    if (e1) throw new Error(`[supabase/vaultPasses.create] ${e1.message}`);

    const { error: e2 } = await this.sb.from("aegis_encrypted_secrets").upsert(
      {
        secret_ref:     pass.secret_ref,
        user_id:        pass.user_id,
        pass_id:        pass.pass_id,
        provider:       blob.provider,
        version:        blob.version,
        algorithm:      blob.algorithm,
        nonce_b64:      blob.nonce_b64,
        ciphertext_b64: blob.ciphertext_b64,
        tag_b64:        blob.tag_b64,
        aad_b64:        blob.aad_b64 ?? null,
        created_at:     blob.created_at,
      },
      { onConflict: "secret_ref" }
    );
    if (e2) throw new Error(`[supabase/encryptedSecrets.create] ${e2.message}`);

    // Mirror to local Maps — temporary bridge for non-migrated direct-Map readers.
    aegisVaultPasses.set(pass.pass_id, pass);
    encryptedSecretVault.set(pass.secret_ref, blob);
  }

  async deleteVaultPass(passId: string): Promise<void> {
    // Cascade FK on aegis_encrypted_secrets deletes the secret blob automatically.
    const { error } = await this.sb
      .from("aegis_vault_passes")
      .delete()
      .eq("pass_id", passId);
    if (error) throw new Error(`[supabase/vaultPasses.delete] ${error.message}`);

    // Mirror deletion to local Maps.
    const pass = aegisVaultPasses.get(passId);
    if (pass) encryptedSecretVault.delete(pass.secret_ref);
    aegisVaultPasses.delete(passId);
  }

  async hasEncryptedSecret(secretRef: string): Promise<boolean> {
    const { count, error } = await this.sb
      .from("aegis_encrypted_secrets")
      .select("secret_ref", { count: "exact", head: true })
      .eq("secret_ref", secretRef);
    if (error) throw new Error(`[supabase/encryptedSecrets.has] ${error.message}`);
    return (count ?? 0) > 0;
  }

  async getEncryptedSecret(secretRef: string): Promise<EncryptedSecretBlob | undefined> {
    const { data, error } = await this.sb
      .from("aegis_encrypted_secrets")
      .select("*")
      .eq("secret_ref", secretRef)
      .maybeSingle();
    if (error) throw new Error(`[supabase/encryptedSecrets.get] ${error.message}`);
    return data ? rowToBlob(data) : undefined;
  }
}

// ─── Row Mappers ──────────────────────────────────────────────────────────────

function rowToVaultPass(row: Record<string, unknown>): AegisVaultPass {
  return {
    pass_id:    row.pass_id as string,
    user_id:    row.user_id as string,
    label:      row.label as string,
    kind:       row.kind as "login_password",
    domain:     row.domain as string,
    username:   (row.username as string | null) ?? undefined,
    secret_ref: row.secret_ref as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function rowToBlob(row: Record<string, unknown>): EncryptedSecretBlob {
  return {
    provider:       row.provider as "local_dev",
    version:        row.version as 1,
    algorithm:      row.algorithm as "aes-256-gcm",
    nonce_b64:      row.nonce_b64 as string,
    ciphertext_b64: row.ciphertext_b64 as string,
    tag_b64:        row.tag_b64 as string,
    aad_b64:        (row.aad_b64 as string | null) ?? undefined,
    created_at:     row.created_at as string,
  };
}

// ─── Singleton Factory ────────────────────────────────────────────────────────

let _vault: VaultRepository | null = null;

export function getVaultRepository(): VaultRepository {
  if (!_vault) {
    _vault =
      getPersistenceProvider() === "supabase"
        ? new SupabaseVaultRepository()
        : new LocalVaultRepository();
  }
  return _vault;
}
