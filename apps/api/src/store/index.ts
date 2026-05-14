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
  DelegationPassport,
  ActionAuthorizationReceipt,
  WebsiteTrustAssertion,
  PaymentMethodCapability,
  SpendingLimitStepUp,
  SecretFieldInjection,
  CredentialUseAuthorization,
  SecurityChallenge,
  ChallengeEmailResolution,
  AegisWorkspace,
  WorkspaceTask,
  WorkspaceArtifact,
} from "@aegis/types";
import type { EncryptedSecretBlob } from "../lib/kms.js";

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

// KMS-encrypted secret vault. Key: pass.secret_ref. Replaces devSecretVault for all new writes.
// Persisted to disk as encryptedSecretVaultEntries (ciphertext only — never plaintext).
export const encryptedSecretVault = new Map<string, EncryptedSecretBlob>();

/**
 * @deprecated Replaced by encryptedSecretVault + KmsProvider. No longer written to.
 * Kept exported for backward compatibility. Will be removed in a future session.
 * The old devSecretVault.set("devvault://demo-login-password", "demo_pass") seeding
 * has been removed — demo secret is now encrypted at startup by seedDefaultData().
 */
export const devSecretVault = new Map<string, string>();

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

// Signed delegation passports issued to agents; local JSON persistence only (v1).
export const delegationPassports = new Map<string, DelegationPassport>();

// Signed action authorization receipts created at approval time; local JSON persistence only (v1).
export const actionAuthorizations = new Map<string, ActionAuthorizationReceipt>();

// Signed website trust assertions issued to agents for website handshake; local JSON persistence only (v1).
export const websiteTrustAssertions = new Map<string, WebsiteTrustAssertion>();

// Tokenized payment method capabilities — metadata only, no raw card data (no PAN, no CVV).
export const paymentMethods = new Map<string, PaymentMethodCapability>();

// One-time user-approved spending step-ups keyed by run_id. Never mutates the collar.
export const spendingLimitStepUps = new Map<string, SpendingLimitStepUp>();

// Agent-Browser Secret Injection requests (v1). Ephemeral — expire on restart (browser CDP context is gone).
export const secretFieldInjections = new Map<string, SecretFieldInjection>();

// One-approval credential-use sessions covering username + password injection for a single login attempt.
export const credentialUseAuthorizations = new Map<string, CredentialUseAuthorization>();

// Security challenge metadata for Challenge Relay v1. Ephemeral — expire on restart.
// Raw codes are never stored here; they live in challengeInjection.challengeCodes (memory-only).
export const securityChallenges = new Map<string, SecurityChallenge>();

// Email resolution requests for Connected Email Challenge Resolver v1.
// resolutionCodes (resolved codes) live in emailChallengeResolver.resolutionCodes (memory-only, never persisted).
export const challengeEmailResolutions = new Map<string, ChallengeEmailResolution>();

// ─── Aegis Workspaces v0 ──────────────────────────────────────────────────────

export const aegisWorkspaces = new Map<string, AegisWorkspace>();

export const workspaceTasks = new Map<string, WorkspaceTask>();

export const workspaceArtifacts = new Map<string, WorkspaceArtifact>();

/**
 * Lightweight audit events for workspace operations.
 * Not wired into signed receipts or the sensitive timeline in v0.
 * TODO(v1): integrate into sensitiveReceiptsRouter derivation as event_group "workspace".
 */
export interface WorkspaceAuditEvent {
  event_id: string;
  workspace_id: string;
  task_id?: string;
  artifact_id?: string;
  delegation_id?: string;
  actor_type?: "user" | "delegation";
  actor_id?: string;
  event_type: "task_claimed" | "task_completed" | "artifact_created" | "task_reset";
  created_at: string;
}

export const workspaceAuditEvents = new Map<string, WorkspaceAuditEvent>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const MOCK_USER_ID = "user_001";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function makePassBindingKey(user_id: string, route_id: string, purpose: string): string {
  return `${user_id}:${route_id}:${purpose}`;
}
