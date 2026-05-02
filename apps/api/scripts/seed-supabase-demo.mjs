/**
 * Seed demo vault pass + encrypted secret into Supabase.
 *
 * Usage:
 *   node apps/api/scripts/seed-supabase-demo.mjs
 *
 * Requires env vars (read from repo root .env or process.env):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   AEGIS_LOCAL_KMS_KEY_B64
 *
 * Safe to re-run — upserts on conflict.
 * Does NOT insert plaintext passwords.
 */

import { readFileSync } from "fs";
import { createCipheriv, randomBytes } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Load .env from repo root ─────────────────────────────────────────────────

function loadEnvFile() {
  const envPath = join(__dirname, "../../../.env");
  let raw;
  try {
    raw = readFileSync(envPath, "utf-8");
  } catch {
    return; // .env may not exist in CI; rely on process.env
  }
  for (const line of raw.split("\n")) {
    const match = line.match(/^([^#=\s]+)\s*=\s*"?(.+?)"?\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

loadEnvFile();

// ─── Validate env ─────────────────────────────────────────────────────────────

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, AEGIS_LOCAL_KMS_KEY_B64 } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("[seed-supabase-demo] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}
if (!AEGIS_LOCAL_KMS_KEY_B64) {
  console.error("[seed-supabase-demo] AEGIS_LOCAL_KMS_KEY_B64 is required.");
  process.exit(1);
}

// ─── Supabase client ──────────────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─── AES-256-GCM encryption (mirrors LocalDevKmsProvider) ────────────────────

function encryptDemoPassword(plaintext) {
  const key = Buffer.from(AEGIS_LOCAL_KMS_KEY_B64, "base64");
  if (key.length !== 32) {
    throw new Error("[seed-supabase-demo] AEGIS_LOCAL_KMS_KEY_B64 must decode to 32 bytes.");
  }
  // AAD must match what LocalDevKmsProvider builds for this context.
  const aad = Buffer.from(
    "user_001|pass_vault_demo_login_001|localhost|login_password",
    "utf-8"
  );
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    provider: "local_dev",
    version: 1,
    algorithm: "aes-256-gcm",
    nonce_b64: nonce.toString("base64"),
    ciphertext_b64: ct.toString("base64"),
    tag_b64: tag.toString("base64"),
    aad_b64: aad.toString("base64"),
    created_at: new Date().toISOString(),
  };
}

// ─── Seed ─────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Upsert demo vault pass metadata
  const { error: e1 } = await supabase.from("aegis_vault_passes").upsert(
    {
      pass_id:    "pass_vault_demo_login_001",
      user_id:    "user_001",
      label:      "Demo Login Account",
      kind:       "login_password",
      domain:     "localhost",
      username:   "demo_user",
      secret_ref: "devvault://demo-login-password",
      created_at: "2026-04-30T12:00:00.000Z",
      updated_at: "2026-04-30T12:00:00.000Z",
    },
    { onConflict: "pass_id" }
  );
  if (e1) throw new Error(`[seed-supabase-demo] vault pass upsert failed: ${e1.message}`);
  console.log("Upserted demo vault pass (pass_vault_demo_login_001).");

  // 2. Encrypt demo password and upsert encrypted blob
  const blob = encryptDemoPassword("demo_pass");
  const { error: e2 } = await supabase.from("aegis_encrypted_secrets").upsert(
    {
      secret_ref:     "devvault://demo-login-password",
      user_id:        "user_001",
      pass_id:        "pass_vault_demo_login_001",
      ...blob,
    },
    { onConflict: "secret_ref" }
  );
  if (e2) throw new Error(`[seed-supabase-demo] encrypted secret upsert failed: ${e2.message}`);
  console.log("Upserted encrypted secret blob (devvault://demo-login-password).");

  console.log("Supabase demo seed complete. No plaintext passwords were inserted.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
