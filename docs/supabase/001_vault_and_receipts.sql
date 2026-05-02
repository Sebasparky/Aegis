-- Supabase Persistence v1: Vault Passes, Encrypted Secrets, Receipts
-- Apply this migration in the Supabase SQL editor.
-- The Aegis API uses the service_role key, which bypasses RLS.
-- No anon/public policies are added — deny-by-default.

-- ─── 1. Vault Pass Metadata ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.aegis_vault_passes (
  pass_id    TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  label      TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'login_password',
  domain     TEXT NOT NULL,
  username   TEXT,
  secret_ref TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.aegis_vault_passes ENABLE ROW LEVEL SECURITY;
-- service_role bypasses RLS automatically.
-- When full user auth is added, add a policy: user_id = auth.uid()

-- ─── 2. Encrypted Secret Blobs ────────────────────────────────────────────────
-- Stores ONLY ciphertext (AES-256-GCM output from the Aegis KMS layer).
-- No plaintext column exists. Decryption happens in apps/api only.

CREATE TABLE IF NOT EXISTS public.aegis_encrypted_secrets (
  secret_ref      TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  pass_id         TEXT NOT NULL
    REFERENCES public.aegis_vault_passes(pass_id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  algorithm       TEXT NOT NULL DEFAULT 'aes-256-gcm',
  nonce_b64       TEXT NOT NULL,
  ciphertext_b64  TEXT NOT NULL,
  tag_b64         TEXT NOT NULL,
  aad_b64         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.aegis_encrypted_secrets ENABLE ROW LEVEL SECURITY;

-- ─── 3. Route Run Receipts ────────────────────────────────────────────────────
-- Immutable audit records for completed/failed route runs.
-- receipt_json holds the full RouteRunReceipt object for type recovery.
-- receipt_hash is SHA-256 of stable-stringified receipt_json for tamper evidence.

CREATE TABLE IF NOT EXISTS public.aegis_receipts (
  receipt_id                      TEXT PRIMARY KEY,
  run_id                          TEXT NOT NULL,
  user_id                         TEXT NOT NULL,
  agent_id                        TEXT,
  domain                          TEXT,
  status                          TEXT NOT NULL,
  credential_used                 BOOLEAN NOT NULL DEFAULT false,
  pass_ids_used                   TEXT[] NOT NULL DEFAULT '{}',
  secret_values_revealed_to_agent BOOLEAN NOT NULL DEFAULT false,
  execution_surface               TEXT,
  receipt_json                    JSONB NOT NULL,
  receipt_hash                    TEXT NOT NULL,
  previous_receipt_hash           TEXT,  -- reserved for future hash-chain hardening
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS aegis_receipts_run_id_idx
  ON public.aegis_receipts(run_id);

CREATE INDEX IF NOT EXISTS aegis_receipts_user_id_idx
  ON public.aegis_receipts(user_id);

ALTER TABLE public.aegis_receipts ENABLE ROW LEVEL SECURITY;
