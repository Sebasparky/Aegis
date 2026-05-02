import type { RouteRunReceipt } from "@aegis/types";
import { getPersistenceProvider } from "../lib/persistenceProvider.js";
import { getSupabaseAdminClient } from "../lib/supabase.js";
import { hashReceipt } from "../lib/receiptHash.js";
import { routeRunReceipts } from "../store/index.js";

// ─── Interface ────────────────────────────────────────────────────────────────

export interface ReceiptRepository {
  createReceipt(receipt: RouteRunReceipt): Promise<void>;
  listReceipts(userId: string): Promise<RouteRunReceipt[]>;
  getReceipt(receiptId: string): Promise<RouteRunReceipt | undefined>;
  findByRunId(runId: string): Promise<RouteRunReceipt | undefined>;
}

// ─── Local (Map) Implementation ───────────────────────────────────────────────

class LocalReceiptRepository implements ReceiptRepository {
  async createReceipt(receipt: RouteRunReceipt): Promise<void> {
    routeRunReceipts.set(receipt.receipt_id, receipt);
  }

  async listReceipts(userId: string): Promise<RouteRunReceipt[]> {
    return Array.from(routeRunReceipts.values()).filter((r) => r.user_id === userId);
  }

  async getReceipt(receiptId: string): Promise<RouteRunReceipt | undefined> {
    return routeRunReceipts.get(receiptId);
  }

  async findByRunId(runId: string): Promise<RouteRunReceipt | undefined> {
    return Array.from(routeRunReceipts.values()).find((r) => r.run_id === runId);
  }
}

// ─── Supabase Implementation ──────────────────────────────────────────────────
// Dual-writes to routeRunReceipts Map so in-process state stays consistent.
// Reads are authoritative from Supabase (durable after restart).

class SupabaseReceiptRepository implements ReceiptRepository {
  private get sb() {
    return getSupabaseAdminClient();
  }

  async createReceipt(receipt: RouteRunReceipt): Promise<void> {
    const receiptHash = hashReceipt(receipt);
    const { error } = await this.sb.from("aegis_receipts").upsert(
      {
        receipt_id:                     receipt.receipt_id,
        run_id:                         receipt.run_id,
        user_id:                        receipt.user_id,
        agent_id:                       receipt.agent_id ?? null,
        domain:                         receipt.domain ?? null,
        status:                         receipt.status,
        credential_used:                receipt.credential_used ?? false,
        pass_ids_used:                  receipt.pass_ids_used ?? [],
        secret_values_revealed_to_agent: receipt.secret_values_revealed_to_agent ?? false,
        execution_surface:              receipt.execution_surface,
        receipt_json:                   receipt,
        receipt_hash:                   receiptHash,
      },
      { onConflict: "receipt_id" }
    );
    if (error) throw new Error(`[supabase/receipts.create] ${error.message}`);

    // Mirror to local Map for in-process consistency.
    routeRunReceipts.set(receipt.receipt_id, receipt);
  }

  async listReceipts(userId: string): Promise<RouteRunReceipt[]> {
    const { data, error } = await this.sb
      .from("aegis_receipts")
      .select("receipt_json")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`[supabase/receipts.list] ${error.message}`);
    return (data ?? []).map((row) => row.receipt_json as RouteRunReceipt);
  }

  async getReceipt(receiptId: string): Promise<RouteRunReceipt | undefined> {
    const { data, error } = await this.sb
      .from("aegis_receipts")
      .select("receipt_json")
      .eq("receipt_id", receiptId)
      .maybeSingle();
    if (error) throw new Error(`[supabase/receipts.get] ${error.message}`);
    return data ? (data.receipt_json as RouteRunReceipt) : undefined;
  }

  async findByRunId(runId: string): Promise<RouteRunReceipt | undefined> {
    const { data, error } = await this.sb
      .from("aegis_receipts")
      .select("receipt_json")
      .eq("run_id", runId)
      .maybeSingle();
    if (error) throw new Error(`[supabase/receipts.findByRunId] ${error.message}`);
    return data ? (data.receipt_json as RouteRunReceipt) : undefined;
  }
}

// ─── Singleton Factory ────────────────────────────────────────────────────────

let _receipt: ReceiptRepository | null = null;

export function getReceiptRepository(): ReceiptRepository {
  if (!_receipt) {
    _receipt =
      getPersistenceProvider() === "supabase"
        ? new SupabaseReceiptRepository()
        : new LocalReceiptRepository();
  }
  return _receipt;
}
