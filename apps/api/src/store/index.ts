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
  AgentConnector,
  AegisRoute,
  Skill,
  PublishedSkillVersion,
  InstalledSkill,
  RouteRun,
  RouteRunReceipt,
  DelegationPassport,
  ActionAuthorizationReceipt,
  WebsiteTrustAssertion,
  PaymentMethodCapability,
  PaymentMethod,
  SpendingLimitStepUp,
  SecretFieldInjection,
  CredentialUseAuthorization,
  SecurityChallenge,
  ChallengeEmailResolution,
  HumanVerificationRequest,
  AegisWorkspace,
  WorkspaceTask,
  WorkspaceArtifact,
  UserApprovalReceipt,
  WebsiteTrustProfile,
  WebsiteViolationReceipt,
  SensitiveGrant,
  PaymentCardFillAuthorization,
  PaymentCardFillRequest,
  PaymentCardField,
  PurchaseConfirmationAuthorization,
  PurchaseConfirmationHandoffRecord,
  VerificationProviderSession,
  ExternalVerificationSession,
  VerificationCard,
  DisclosureReceipt,
  TrustSignalDisclosureRecord,
  PrivateProfileMemoryItem,
  ProfileFieldFillRequest,
  ProfileMemoryRequest,
  AccountCreationRequest,
  AccountCreationStepRequest,
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

export const agentConnectors = new Map<string, AgentConnector>();

export const routes = new Map<string, AegisRoute>();

export const skills = new Map<string, Skill>();

export const publishedSkillVersions = new Map<string, PublishedSkillVersion>();

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
  resolve_token?: string;       // one-time token; generated at session approval or fill creation
  resolve_token_used?: boolean; // true after first successful resolution; prevents replay
}

// Field-level credential delegation sessions — dev prototype only.
export const credentialSessions = new Map<string, CredentialUseSession>();

// Pending/active field fill requests picked up and executed by the extension.
export const credentialFillRequests = new Map<string, CredentialFillRequest>();

// Signed delegation passports issued to agents; local JSON persistence only (v1).
export const delegationPassports = new Map<string, DelegationPassport>();

// Signed action authorization receipts created at approval time; local JSON persistence only (v1).
export const actionAuthorizations = new Map<string, ActionAuthorizationReceipt>();

// Signed user approval receipts — liability-grade records of user approve/deny clicks at trust boundaries.
// Covers: ApprovalRequest approve/deny and route-run rejection. Local JSON persistence (v1).
export const userApprovalReceipts = new Map<string, UserApprovalReceipt>();

// Signed website trust assertions issued to agents for website handshake; local JSON persistence only (v1).
export const websiteTrustAssertions = new Map<string, WebsiteTrustAssertion>();

// Signed website trust profiles — website/company-side declared promise snapshots (v1).
export const websiteTrustProfiles = new Map<string, WebsiteTrustProfile>();

// Signed website violation receipts — proof that a website violated a committed safety promise.
// References WebsiteTrustProfile.profile_hash as the historical promise snapshot anchor.
export const websiteViolationReceipts = new Map<string, WebsiteViolationReceipt>();

// Tokenized payment method capabilities — metadata only, no raw card data (no PAN, no CVV).
export const paymentMethods = new Map<string, PaymentMethod>();

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

// Human Presence Relay v1 — human-verification challenge requests. Metadata only:
// no selectors, no coordinates, no gesture recordings (live hold state is
// memory-only in humanPresenceRelay.holdSessions and is never stored here).
// Pending/in-progress requests expire on restart (browser context is gone).
export const humanVerificationRequests = new Map<string, HumanVerificationRequest>();

// Task-scoped sensitive grants — created at credential authorization approval and challenge code
// submission. Each grant links to a signed UserApprovalReceipt (linked_uar_id) as the liability proof.
// Active grants are session-bound: they are expired on restart (same pattern as credentialUseAuthorizations).
export const sensitiveGrants = new Map<string, SensitiveGrant>();

// Credential Step Handoff v1 audit records. Ephemeral — expire on restart.
// Never stores pass_id, secret_ref, resolvedValue, or any raw credential material.
export interface CredentialStepHandoffRecord {
  handoff_id: string;
  injection_request_id: string;
  delegation_id: string;
  user_id: string;
  domain: string;
  step_kind: "username_next" | "password_submit";
  /** Display label only — never pass_id or raw credential value. */
  pass_label: string;
  outcome: string; // CredentialStepHandoffStatus
  raw_value_revealed_to_agent: false;
  completed_at: string;
  challenge_kind?: "totp" | "email_code" | "sms_code" | "captcha" | "unknown";
  authorization_id?: string;
}

export const credentialStepHandoffs = new Map<string, CredentialStepHandoffRecord>();

// ─── Payment Card Fill Handoff v1 ─────────────────────────────────────────────
// Card fill approval + CDP field injection. Purchase confirmation is NOT implemented.

// One user approval per domain/payment-method combination, covering all requested card fields.
// Ephemeral — expired on restart (CDP browser context is gone).
export const paymentCardFillAuthorizations = new Map<string, PaymentCardFillAuthorization>();

// Per-field fill requests linked to a PaymentCardFillAuthorization.
// Ephemeral — expired on restart.
export const paymentCardFillRequests = new Map<string, PaymentCardFillRequest>();

// Audit records for completed card fill handoffs. Ephemeral — never persisted.
// Never stores payment_method_id, card_number_ref, cvv_ref, or any raw card value.
export interface PaymentCardFillHandoffRecord {
  handoff_id: string;                    // "pcfh_..."
  fill_request_id: string;
  authorization_id: string;
  delegation_id: string;
  user_id: string;
  domain: string;
  field: PaymentCardField;
  /** Display label only — never payment_method_id or any raw card data. */
  payment_method_label: string;
  last4: string;
  outcome: "filled" | "failed";
  /** Always the literal false — raw card values are never returned to the agent. */
  raw_values_revealed_to_agent: false;
  /** Always the literal true — filling card fields does not authorize any purchase. */
  purchase_not_authorized: true;
  completed_at: string;
}
export const paymentCardFillHandoffs = new Map<string, PaymentCardFillHandoffRecord>();

// ─── Private Profile Memory v1 ────────────────────────────────────────────────
// KMS-encrypted checkout/contact profile fields. value_ref = "ppvault://{memory_id}/value".
// encryptedSecretVault key = memory_id directly.
// Raw values never stored inline; never returned in any agent-facing response.
export const privateProfileMemory = new Map<string, PrivateProfileMemoryItem>();

// Per-request fill records. Ephemeral — expired on restart (CDP browser context is gone).
export const profileFieldFillRequests = new Map<string, ProfileFieldFillRequest>();

// Pending profile memory requests — created when profile-field-fill is missing values.
// Persisted for UI continuity; pending_user requests are expired on restart.
export const profileMemoryRequests = new Map<string, ProfileMemoryRequest>();

// ─── Purchase Confirmation Handoff v1 ─────────────────────────────────────────
// Separate from PaymentCardFillAuthorization — purchase_action_authorized starts false.
// Ephemeral — expired on restart (CDP browser context is gone).
export const purchaseConfirmationAuthorizations = new Map<string, PurchaseConfirmationAuthorization>();

// Audit records for completed purchase confirmation handoffs. Never stores card values or KMS material.
export const purchaseConfirmationHandoffs = new Map<string, PurchaseConfirmationHandoffRecord>();

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

// ─── Verification Foundation v1 ───────────────────────────────────────────────

/** Ephemeral provider sessions — not persisted; expire after 30 min or on restart. */
export const verificationProviderSessions = new Map<string, VerificationProviderSession>();

/** Ephemeral external verification sessions — not persisted; expire after 30 min or on restart. */
export const externalVerificationSessions = new Map<string, ExternalVerificationSession>();

export const verificationCards = new Map<string, VerificationCard>();

export const disclosureReceipts = new Map<string, DisclosureReceipt>();

export const trustSignalDisclosureRecords = new Map<string, TrustSignalDisclosureRecord>();

// ─── Account Access Resolution v1 ─────────────────────────────────────────────
// Ephemeral — browser context is gone on restart. pending_user requests
// implicitly expire because this map starts empty after restart.
export const accountCreationRequests = new Map<string, AccountCreationRequest>();

// ─── Account Creation v2 — Step requests ─────────────────────────────────────
// Ephemeral — short-lived, linked to an approved AccountCreationRequest.
export const accountCreationStepRequests = new Map<string, AccountCreationStepRequest>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const MOCK_USER_ID = "user_001";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function makePassBindingKey(user_id: string, route_id: string, purpose: string): string {
  return `${user_id}:${route_id}:${purpose}`;
}
