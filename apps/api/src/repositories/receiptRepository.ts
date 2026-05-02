import type { RouteRunReceipt } from "@aegis/types";
import { getPersistenceProvider } from "../lib/persistenceProvider.js";
import { getSupabaseAdminClient } from "../lib/supabase.js";
import { hashReceipt } from "../lib/receiptHash.js";
import {
  signReceiptJws,
  verifyReceiptJws,
  UnsignedDevModeError,
  type ReceiptJwsPayload,
} from "../lib/receiptSigning.js";
import { routeRunReceipts } from "../store/index.js";

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface ReceiptVerificationResult {
  receipt_id: string;
  valid: boolean;
  hash_valid: boolean;
  signature_valid: boolean;
  chain_previous_exists?: boolean;
  receipt_hash?: string;
  recomputed_hash?: string;
  previous_receipt_hash?: string | null;
  jws_payload?: ReceiptJwsPayload;
  error?: string;
}

export interface ReceiptRepository {
  createReceipt(receipt: RouteRunReceipt): Promise<void>;
  listReceipts(userId: string): Promise<RouteRunReceipt[]>;
  getReceipt(receiptId: string): Promise<RouteRunReceipt | undefined>;
  findByRunId(runId: string): Promise<RouteRunReceipt | undefined>;
  verifyReceipt(receiptId: string): Promise<ReceiptVerificationResult | null>;
}

// ─── Local (Map) Implementation ───────────────────────────────────────────────
// Signing is best-effort: all signing errors are swallowed so local/test mode
// never fails due to missing keys. Hash chaining is still computed for integrity.

interface LocalReceiptMeta {
  receipt_hash: string;
  previous_receipt_hash: string | null;
  receipt_jws: string | null;
  issuer: string;
  issued_at: string;
}

const localReceiptMeta = new Map<string, LocalReceiptMeta>();

class LocalReceiptRepository implements ReceiptRepository {
  async createReceipt(receipt: RouteRunReceipt): Promise<void> {
    // Best-effort chain: find the most recent receipt for this user by created_at.
    const userReceipts = Array.from(routeRunReceipts.values())
      .filter((r) => r.user_id === receipt.user_id)
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    const previousReceiptHash =
      userReceipts.length > 0
        ? (localReceiptMeta.get(userReceipts[0].receipt_id)?.receipt_hash ?? null)
        : null;

    const receiptHash = hashReceipt(receipt, previousReceiptHash);
    const issuer = process.env.AEGIS_RECEIPT_ISSUER ?? "aegis-dev";
    const issuedAt = new Date().toISOString();
    const jwsPayload: ReceiptJwsPayload = {
      typ: "aegis.receipt.v1",
      receipt_id: receipt.receipt_id,
      receipt_hash: receiptHash,
      previous_receipt_hash: previousReceiptHash,
      issuer,
      issued_at: issuedAt,
    };

    let receiptJws: string | null = null;
    try {
      receiptJws = await signReceiptJws(jwsPayload);
    } catch {
      // Local mode is best-effort signed — swallow all signing errors.
    }

    localReceiptMeta.set(receipt.receipt_id, {
      receipt_hash: receiptHash,
      previous_receipt_hash: previousReceiptHash,
      receipt_jws: receiptJws,
      issuer,
      issued_at: issuedAt,
    });
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

  async verifyReceipt(receiptId: string): Promise<ReceiptVerificationResult | null> {
    const receipt = routeRunReceipts.get(receiptId);
    if (!receipt) return null;

    const meta = localReceiptMeta.get(receiptId);
    if (!meta) {
      return {
        receipt_id: receiptId,
        valid: false,
        hash_valid: false,
        signature_valid: false,
        error: "NO_METADATA",
      };
    }

    const recomputed = hashReceipt(receipt, meta.previous_receipt_hash);
    const hashValid = recomputed === meta.receipt_hash;

    let signatureValid = false;
    let jwsPayload: ReceiptJwsPayload | undefined;
    let sigError: string | undefined;
    if (!meta.receipt_jws) {
      sigError = "NO_JWS";
    } else {
      const result = await verifyReceiptJws(meta.receipt_jws);
      signatureValid = result.valid;
      jwsPayload = result.payload;
      sigError = result.error;
      if (signatureValid && jwsPayload) {
        if (
          jwsPayload.receipt_id !== receiptId ||
          jwsPayload.receipt_hash !== meta.receipt_hash
        ) {
          signatureValid = false;
        }
      }
    }

    let chainPreviousExists: boolean | undefined;
    if (meta.previous_receipt_hash !== null) {
      chainPreviousExists = Array.from(localReceiptMeta.values()).some(
        (m) => m.receipt_hash === meta.previous_receipt_hash
      );
    }

    // In unsigned dev mode, valid is determined by hash alone; signature is informational.
    const valid = hashValid && (meta.receipt_jws ? signatureValid : true);

    return {
      receipt_id: receiptId,
      valid,
      hash_valid: hashValid,
      signature_valid: signatureValid,
      ...(chainPreviousExists !== undefined ? { chain_previous_exists: chainPreviousExists } : {}),
      receipt_hash: meta.receipt_hash,
      recomputed_hash: recomputed,
      previous_receipt_hash: meta.previous_receipt_hash,
      ...(jwsPayload ? { jws_payload: jwsPayload } : {}),
      ...(sigError ? { error: sigError } : {}),
    };
  }
}

// ─── Supabase Implementation ──────────────────────────────────────────────────
// Dual-writes to routeRunReceipts Map so in-process state stays consistent.
// Reads are authoritative from Supabase (durable after restart).
// Receipts use INSERT (not upsert) — rows are append-only, enforced by DB trigger.

class SupabaseReceiptRepository implements ReceiptRepository {
  private get sb() {
    return getSupabaseAdminClient();
  }

  async createReceipt(receipt: RouteRunReceipt): Promise<void> {
    // 1. Fetch the latest receipt_hash for this user to build the chain link.
    //    SELECT + INSERT is not atomic; sequential receipt creation per user is assumed.
    const { data: latest } = await this.sb
      .from("aegis_receipts")
      .select("receipt_hash")
      .eq("user_id", receipt.user_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const previousReceiptHash = (latest as { receipt_hash: string } | null)?.receipt_hash ?? null;

    // 2. Compute chained hash.
    const receiptHash = hashReceipt(receipt, previousReceiptHash);

    // 3. Build JWS payload — no secrets, only metadata.
    const issuer = process.env.AEGIS_RECEIPT_ISSUER ?? "aegis-dev";
    const issuedAt = new Date().toISOString();
    const jwsPayload: ReceiptJwsPayload = {
      typ: "aegis.receipt.v1",
      receipt_id: receipt.receipt_id,
      receipt_hash: receiptHash,
      previous_receipt_hash: previousReceiptHash,
      issuer,
      issued_at: issuedAt,
    };

    // 4. Sign — allow unsigned only if UnsignedDevModeError (explicit dev opt-in).
    let receiptJws: string | null = null;
    try {
      receiptJws = await signReceiptJws(jwsPayload);
    } catch (e) {
      if (e instanceof UnsignedDevModeError) {
        receiptJws = null;
        console.warn("[receipts] Inserting unsigned receipt (AEGIS_RECEIPT_ALLOW_UNSIGNED_DEV=true). Set signing keys for production.");
      } else {
        throw e;
      }
    }

    // 5. INSERT (not upsert — receipts are append-only per DB trigger).
    const { error } = await this.sb.from("aegis_receipts").insert({
      receipt_id:                      receipt.receipt_id,
      run_id:                          receipt.run_id,
      user_id:                         receipt.user_id,
      agent_id:                        receipt.agent_id ?? null,
      domain:                          receipt.domain ?? null,
      status:                          receipt.status,
      credential_used:                 receipt.credential_used ?? false,
      pass_ids_used:                   receipt.pass_ids_used ?? [],
      secret_values_revealed_to_agent: receipt.secret_values_revealed_to_agent ?? false,
      execution_surface:               receipt.execution_surface,
      receipt_json:                    receipt,
      receipt_hash:                    receiptHash,
      previous_receipt_hash:           previousReceiptHash,
      receipt_jws:                     receiptJws,
      issuer,
      issued_at:                       issuedAt,
    });
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

  async verifyReceipt(receiptId: string): Promise<ReceiptVerificationResult | null> {
    // Fetch all columns needed for verification.
    const { data, error } = await this.sb
      .from("aegis_receipts")
      .select("receipt_json, receipt_hash, previous_receipt_hash, receipt_jws")
      .eq("receipt_id", receiptId)
      .maybeSingle();
    if (error) throw new Error(`[supabase/receipts.verify] ${error.message}`);
    if (!data) return null;

    const storedReceipt = data.receipt_json as RouteRunReceipt;
    const storedHash = data.receipt_hash as string;
    const previousHash = (data.previous_receipt_hash as string | null) ?? null;
    const storedJws = (data.receipt_jws as string | null) ?? null;

    // Recompute hash and compare.
    const recomputed = hashReceipt(storedReceipt, previousHash);
    const hashValid = recomputed === storedHash;

    // Check the chain link exists if applicable.
    let chainPreviousExists: boolean | undefined;
    if (previousHash !== null) {
      const { count } = await this.sb
        .from("aegis_receipts")
        .select("receipt_id", { count: "exact", head: true })
        .eq("receipt_hash", previousHash);
      chainPreviousExists = (count ?? 0) > 0;
    }

    // Verify JWS.
    let signatureValid = false;
    let jwsPayload: ReceiptJwsPayload | undefined;
    let sigError: string | undefined;
    if (!storedJws) {
      sigError = "NO_JWS";
    } else {
      const result = await verifyReceiptJws(storedJws);
      signatureValid = result.valid;
      jwsPayload = result.payload;
      sigError = result.error;
      // Cross-check payload fields against stored row.
      if (signatureValid && jwsPayload) {
        if (
          jwsPayload.receipt_id !== receiptId ||
          jwsPayload.receipt_hash !== storedHash
        ) {
          signatureValid = false;
          sigError = "JWS_PAYLOAD_MISMATCH";
        }
      }
    }

    const valid =
      hashValid &&
      signatureValid &&
      (chainPreviousExists === undefined || chainPreviousExists);

    return {
      receipt_id: receiptId,
      valid,
      hash_valid: hashValid,
      signature_valid: signatureValid,
      ...(chainPreviousExists !== undefined ? { chain_previous_exists: chainPreviousExists } : {}),
      receipt_hash: storedHash,
      recomputed_hash: recomputed,
      previous_receipt_hash: previousHash,
      ...(jwsPayload ? { jws_payload: jwsPayload } : {}),
      ...(sigError ? { error: sigError } : {}),
    };
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
