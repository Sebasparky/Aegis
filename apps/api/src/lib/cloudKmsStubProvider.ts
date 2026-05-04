import type { KmsProvider, KmsProviderName, EncryptedSecretBlob, KmsContext } from "./kms.js";

// Placeholder for a future production cloud KMS provider (AWS KMS, GCP KMS, Azure Key Vault, etc.).
// This stub always throws CLOUD_KMS_NOT_IMPLEMENTED. It does not fall back to local_dev.
// To enable: set AEGIS_KMS_PROVIDER=cloud_kms_stub in your environment.
// To implement: replace this class with a real provider and extend the factory in kms.ts.
export class CloudKmsStubProvider implements KmsProvider {
  readonly provider: KmsProviderName = "cloud_kms_stub";

  async encryptSecret(_plaintext: string, _context: KmsContext): Promise<EncryptedSecretBlob> {
    throw new Error(
      "CLOUD_KMS_NOT_IMPLEMENTED: cloud_kms_stub provider is a placeholder. " +
        "Configure a real cloud KMS provider to encrypt secrets."
    );
  }

  async decryptSecret(_blob: EncryptedSecretBlob, _context: KmsContext): Promise<string> {
    throw new Error(
      "CLOUD_KMS_NOT_IMPLEMENTED: cloud_kms_stub provider is a placeholder. " +
        "Configure a real cloud KMS provider to decrypt secrets."
    );
  }
}
