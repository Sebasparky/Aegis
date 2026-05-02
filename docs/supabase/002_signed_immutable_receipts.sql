-- Migration 002: Signed + Immutable Receipts v1
-- Adds receipt_jws, issuer, issued_at columns to aegis_receipts.
-- Adds indexes for hash chain traversal and user/time-ordered receipt lookup.
-- Adds append-only triggers: UPDATE and DELETE are forbidden.
--
-- Apply in the Supabase SQL editor (or via supabase db push).
--
-- Note: The service_role key bypasses Row-Level Security but NOT BEFORE triggers.
-- Append-only is enforced for all clients including the API service role.
-- To truncate in dev: DROP TRIGGER first, TRUNCATE, then re-run this migration.

-- ─── New columns ─────────────────────────────────────────────────────────────

ALTER TABLE public.aegis_receipts
  ADD COLUMN IF NOT EXISTS receipt_jws TEXT,
  ADD COLUMN IF NOT EXISTS issuer      TEXT,
  ADD COLUMN IF NOT EXISTS issued_at   TIMESTAMPTZ;

-- ─── Indexes ─────────────────────────────────────────────────────────────────

-- Ordered list for chain traversal (fetch latest receipt per user).
CREATE INDEX IF NOT EXISTS aegis_receipts_created_at_idx
  ON public.aegis_receipts(created_at DESC);

-- Per-user ordered list for receipt history pages.
CREATE INDEX IF NOT EXISTS aegis_receipts_user_created_idx
  ON public.aegis_receipts(user_id, created_at DESC);

-- Lookup a receipt by its hash (used by verifyReceipt to check chain link exists).
CREATE INDEX IF NOT EXISTS aegis_receipts_hash_idx
  ON public.aegis_receipts(receipt_hash);

-- ─── Append-only enforcement ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.prevent_aegis_receipt_mutation()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'aegis_receipts is append-only: % not permitted', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS prevent_aegis_receipt_update ON public.aegis_receipts;
CREATE TRIGGER prevent_aegis_receipt_update
  BEFORE UPDATE ON public.aegis_receipts
  FOR EACH ROW EXECUTE FUNCTION public.prevent_aegis_receipt_mutation();

DROP TRIGGER IF EXISTS prevent_aegis_receipt_delete ON public.aegis_receipts;
CREATE TRIGGER prevent_aegis_receipt_delete
  BEFORE DELETE ON public.aegis_receipts
  FOR EACH ROW EXECUTE FUNCTION public.prevent_aegis_receipt_mutation();
