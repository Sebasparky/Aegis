import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// ─── Public Types ─────────────────────────────────────────────────────────────

// LOCAL DEV ONLY: local_dev is a temporary AES-256-GCM provider for MVP development.
// To swap for cloud KMS: extend KmsProviderName, add a provider class, and add a case in getKmsProvider().
export type KmsProviderName = "local_dev";
// Future providers: | "aws_kms" | "gcp_kms" | "azure_key_vault" | "hsm"

export interface KmsContext {
  user_id: string;
  pass_id: string;
  domain: string;
  purpose: "login_password";
}

export interface EncryptedSecretBlob {
  provider: KmsProviderName;
  version: 1;
  algorithm: "aes-256-gcm";
  nonce_b64: string;
  ciphertext_b64: string;
  tag_b64: string;
  aad_b64?: string; // stored for inspection only — decrypt always recomputes AAD from KmsContext
  created_at: string;
}

export interface KmsProvider {
  provider: KmsProviderName;
  encryptSecret(plaintext: string, context: KmsContext): Promise<EncryptedSecretBlob>;
  decryptSecret(blob: EncryptedSecretBlob, context: KmsContext): Promise<string>;
}

// ─── AAD Construction ─────────────────────────────────────────────────────────

function buildAad(context: KmsContext): Buffer {
  // Binds ciphertext to its context. Any field mismatch during decrypt causes GCM tag failure.
  return Buffer.from(`${context.user_id}|${context.pass_id}|${context.domain}|${context.purpose}`, "utf8");
}

// ─── Local Dev Provider ───────────────────────────────────────────────────────

class LocalDevKmsProvider implements KmsProvider {
  readonly provider = "local_dev" as const;

  private getKey(): Buffer {
    const b64 = process.env.AEGIS_LOCAL_KMS_KEY_B64;
    if (!b64) {
      throw new Error(
        "[kms/local_dev] AEGIS_LOCAL_KMS_KEY_B64 is not set. " +
        "Generate a 32-byte key: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\" " +
        "and add it to .env"
      );
    }
    const key = Buffer.from(b64, "base64");
    if (key.length !== 32) {
      throw new Error(
        `[kms/local_dev] AEGIS_LOCAL_KMS_KEY_B64 decoded to ${key.length} bytes — must be exactly 32 bytes (256 bits).`
      );
    }
    return key;
  }

  async encryptSecret(plaintext: string, context: KmsContext): Promise<EncryptedSecretBlob> {
    const key = this.getKey();
    const nonce = randomBytes(12); // 96-bit nonce — standard for AES-GCM
    const aad = buildAad(context);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad);
    const ciphertextBuf = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag(); // 128-bit GCM authentication tag
    // NEVER log plaintext, key, or tag
    return {
      provider: "local_dev",
      version: 1,
      algorithm: "aes-256-gcm",
      nonce_b64: nonce.toString("base64"),
      ciphertext_b64: ciphertextBuf.toString("base64"),
      tag_b64: tag.toString("base64"),
      aad_b64: aad.toString("base64"),
      created_at: new Date().toISOString(),
    };
  }

  async decryptSecret(blob: EncryptedSecretBlob, context: KmsContext): Promise<string> {
    if (blob.provider !== "local_dev") {
      throw new Error(`[kms/local_dev] Cannot decrypt blob from provider "${blob.provider}"`);
    }
    const key = this.getKey();
    const nonce = Buffer.from(blob.nonce_b64, "base64");
    const ciphertext = Buffer.from(blob.ciphertext_b64, "base64");
    const tag = Buffer.from(blob.tag_b64, "base64");
    const aad = buildAad(context); // always recomputed — not read from blob.aad_b64
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    decipher.setAAD(aad);
    // If AAD doesn't match (wrong context) or tag is invalid (tampered/wrong key),
    // Node throws "Unsupported state or unable to authenticate data"
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    // NEVER log the returned plaintext
  }
}

// ─── Provider Factory ─────────────────────────────────────────────────────────

let _provider: KmsProvider | null = null;

export function getKmsProvider(): KmsProvider {
  if (_provider) return _provider;
  const name = (process.env.AEGIS_KMS_PROVIDER ?? "local_dev") as KmsProviderName;
  if (name === "local_dev") {
    _provider = new LocalDevKmsProvider();
    return _provider;
  }
  // Future: add cases for "aws_kms", "gcp_kms", "azure_key_vault"
  throw new Error(`[kms] Unknown AEGIS_KMS_PROVIDER: "${name}". Supported values: local_dev`);
}
