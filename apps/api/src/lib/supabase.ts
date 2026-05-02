// Supabase admin client — service_role key only.
// NEVER import this module from apps/web or apps/extension.
// The service_role key bypasses RLS and must stay server-side.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

export function getSupabaseAdminClient(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "[supabase] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when AEGIS_PERSISTENCE_PROVIDER=supabase."
    );
  }
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}
