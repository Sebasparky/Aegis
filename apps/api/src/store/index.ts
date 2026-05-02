import { randomUUID } from "crypto";
import type {
  Collar,
  AegisPass,
  AegisVaultPass,
  RoutePassBinding,
  ProtectedSession,
  ApprovalRequest,
  Receipt,
  RunnerTask,
  AgentTask,
  AgentDelegation,
  AegisRoute,
  Skill,
  InstalledSkill,
  RouteRun,
  RouteRunReceipt,
} from "@aegis/types";

// In-memory Maps are the runtime source of truth.
// persistence.ts handles loading from and saving to disk.

export interface User {
  id: string;
  email: string;
  display_name: string;
  aegis_id: string;
  created_at: string;
  updated_at: string;
}

export interface ReputationEvent {
  id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  category?: string;
  severity: string;
  session_id?: string;
  receipt_id?: string;
  domain?: string;
  weight: number;
  created_at: string;
}

export interface DomainTrustRecord {
  id: string;
  domain: string;
  domain_verified: boolean;
  business_verified: boolean;
  business_aegis_id?: string;
  trust_label: string;
  known_prompt_injection_reports: number;
  known_dispute_count: number;
  // Website AegisID fields added in v0
  website_aegis_id?: string;
  business_name?: string;
  agent_policy_published?: boolean;
  created_at: string;
  updated_at: string;
}

// Pass tokens are stored in plaintext for MVP convenience.
// Production must store only the hashed token and never return it after creation.
export interface PassWithToken extends AegisPass {
  token: string;
  revoked_at?: string;
  last_used_at?: string;
}

// ─── Store Maps ───────────────────────────────────────────────────────────────
// Maps are initialized empty; loadStore() in persistence.ts seeds or restores data on startup.

export const users = new Map<string, User>();

export const collars = new Map<string, Collar>();

export const passes = new Map<string, PassWithToken>();

export const sessions = new Map<string, ProtectedSession>();

export const approvals = new Map<string, ApprovalRequest>();

export const receipts = new Map<string, Receipt>();

export const reputationEvents = new Map<string, ReputationEvent>();

export const runnerTasks = new Map<string, RunnerTask>();

export const domainTrust = new Map<string, DomainTrustRecord>();

export const agentTasks = new Map<string, AgentTask>();

export const agentDelegations = new Map<string, AgentDelegation>();

export const routes = new Map<string, AegisRoute>();

export const skills = new Map<string, Skill>();

export const installedSkills = new Map<string, InstalledSkill>();

export const routeRuns = new Map<string, RouteRun>();

export const routeRunReceipts = new Map<string, RouteRunReceipt>();

// Credential vault metadata — dev prototype only, not production-grade encryption.
export const aegisVaultPasses = new Map<string, AegisVaultPass>();

// Route-to-pass bindings. Key: `${user_id}:${route_id}:${purpose}` for upsert semantics.
export const routePassBindings = new Map<string, RoutePassBinding>();

// Dev-only secret store. Values are returned to the Aegis extension only — NEVER to agents or API callers.
// Persisted locally in aegis-store.json under devSecretVaultEntries for dev convenience.
// NOT production-grade — do not store real credentials. Local prototype only.
export const devSecretVault = new Map<string, string>();
// Seeded demo secret always initialized at module load; loadStore() adds persisted user-created secrets on top.
devSecretVault.set("devvault://demo-login-password", "demo_pass");

// ─── Credential Session types ─────────────────────────────────────────────────

export type CredentialSessionStatus =
  | "pending_approval"
  | "active"
  | "completed"
  | "failed"
  | "expired";

export interface CredentialUseSession {
  session_id: string;
  user_id: string;
  agent_id?: string;
  pass_id: string;
  domain: string;
  status: CredentialSessionStatus;
  allowed_fields: Array<"username" | "password">;
  fields_filled: Array<{
    field: "username" | "password";
    filled_at: string;
    tab_url?: string;
  }>;
  approved_at?: string;
  expires_at?: string;
  target_url?: string;
  url_match?: {
    hostname: string;
    path_prefix?: string;
  };
  created_at: string;
  updated_at: string;
}

export type FieldFillStatus = "pending" | "running" | "completed" | "failed";

export interface CredentialFillRequest {
  request_id: string;
  session_id: string;
  field: "username" | "password";
  domain: string;
  status: FieldFillStatus;
  created_at: string;
  completed_at?: string;
  error?: string;
}

// Field-level credential delegation sessions — dev prototype only.
export const credentialSessions = new Map<string, CredentialUseSession>();

// Pending/active field fill requests picked up and executed by the extension.
export const credentialFillRequests = new Map<string, CredentialFillRequest>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const MOCK_USER_ID = "user_001";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
