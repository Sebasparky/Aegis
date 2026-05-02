export type PersistenceProvider = "local" | "supabase";

export function getPersistenceProvider(): PersistenceProvider {
  const p = process.env.AEGIS_PERSISTENCE_PROVIDER ?? "local";
  if (p === "local" || p === "supabase") return p as PersistenceProvider;
  throw new Error(`[persistence] Unknown AEGIS_PERSISTENCE_PROVIDER: "${p}". Must be "local" or "supabase".`);
}
