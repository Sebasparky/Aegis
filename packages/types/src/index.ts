// Shared TypeScript interfaces for Aegis
// These types are used by both apps/api and apps/web

export type RunnerTaskStatus = "pending" | "running" | "completed" | "failed" | "expired" | "canceled";
export type RunnerTaskType = "complete_approved_purchase" | "complete_approved_sensitive_action";

export type AgentTaskStatus =
  | "ready"
  | "in_progress"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "canceled";

export type AgentDelegationStatus = "active" | "revoked" | "expired";
export type AgentDelegationChannel = "slack" | "discord" | "api" | "other";
export type SkillAccessMode = "all" | "exclude" | "only";

export type AgentConnectorPlatform =
  | "claude_cowork"
  | "claude_desktop"
  | "generic_mcp"
  | "custom_http";
export type ConnectorPolicyMode = "baseline" | "collar";
export type ConnectorStatus = "created" | "connected" | "revoked";

export interface AgentConnector {
  connector_id: string;
  user_id: string;
  delegation_id: string;
  platform: AgentConnectorPlatform;
  display_name: string;
  policy_mode: ConnectorPolicyMode;
  collar_id?: string;
  status: ConnectorStatus;
  created_at: string;
  updated_at: string;
  last_seen_at?: string;
}

export interface AgentDelegation {
  id: string;
  user_id: string;
  user_aegis_id: string;
  agent_name: string;
  agent_platform?: string;
  channel: AgentDelegationChannel;
  default_collar_id?: string;
  status: AgentDelegationStatus;
  token_id: string;
  created_at: string;
  updated_at: string;
  expires_at?: string;
  skill_access_mode?: SkillAccessMode;
  skill_access_skill_ids?: string[];
}

export interface AgentTask {
  id: string;
  user_id: string;
  user_aegis_id: string;
  title: string;
  description?: string;
  start_url: string;
  start_domain: string;
  website_aegis_id?: string;
  collar_id: string;
  pass_id: string;
  status: AgentTaskStatus;
  constraints: {
    max_purchase_amount: number;
    subscriptions_allowed: boolean;
    purchase_requires_approval: boolean;
    payment_requires_approval: boolean;
    identity_disclosure_blocked: boolean;
  };
  created_at: string;
  updated_at: string;
}

export interface RunnerTask {
  id: string;
  user_id: string;
  session_id: string;
  approval_request_id: string;
  collar_id: string;
  task_type: RunnerTaskType;
  status: RunnerTaskStatus;
  domain?: string;
  constraints: Record<string, unknown>;
  result?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  expires_at: string;
}

export type PolicyDecision =
  | "allow"
  | "allow_and_log"
  | "approval_required"
  | "runner_required"
  | "block"
  | "pause_session"
  | "revoke_session";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type SessionStatus =
  | "active"
  | "paused"
  | "waiting_for_approval"
  | "revoked"
  | "expired"
  | "closed"
  | "error";

export type CollarStatus = "active" | "revoked" | "archived";
export type PassStatus = "active" | "revoked" | "expired";
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "canceled";

export type ActionType =
  | "browse"
  | "search"
  | "read"
  | "compare"
  | "draft"
  | "add_to_cart"
  | "login"
  | "purchase"
  | "payment"
  | "travel_booking"
  | "subscription"
  | "post_publicly"
  | "comment"
  | "direct_message"
  | "send_email"
  | "forward_email"
  | "upload_file"
  | "download_file"
  | "submit_form"
  | "create_account"
  | "share_email"
  | "share_phone"
  | "share_address"
  | "identity_disclosure"
  | "government_id_upload"
  | "medical_data_disclosure"
  | "financial_data_disclosure"
  | "account_setting_change"
  | "delete_account"
  | "connect_app"
  | "oauth_authorize"
  | "save_credential"
  | "save_payment_method"
  | "enable_persistence"
  | "workspace_read"
  | "workspace_task_list"
  | "workspace_task_claim"
  | "workspace_task_complete"
  | "workspace_artifact_create"
  | "workspace_artifact_list"
  | "workspace_artifact_read";

export interface SpendingLimits {
  max_without_approval: number;
  max_with_approval: number;
  subscriptions_allowed: boolean;
}

export interface SpendingLimitStepUp {
  run_id: string;
  original_limit_usd?: number;
  requested_limit_usd: number;
  approved_limit_usd: number;
  currency: string;
  scope: "this_run_only";
  approved_at: string;
  approved_by: "user";
}

export interface CounterpartyRules {
  sensitive_actions_require_verified_business: boolean;
  block_known_prompt_injection_sites: boolean;
}

export interface SessionLimits {
  max_duration_minutes: number;
  max_active_sessions?: number;
}

export interface Collar {
  id: string;
  user_id: string;
  name: string;
  description?: string;
  purpose?: string;
  status: CollarStatus;
  allowed_actions: ActionType[];
  approval_required_actions: ActionType[];
  blocked_actions: ActionType[];
  spending_limits: SpendingLimits;
  counterparty_rules: CounterpartyRules;
  session_limits: SessionLimits;
  created_at: string;
  updated_at: string;
  revoked_at?: string;
}

export interface AegisPass {
  id: string;
  user_id: string;
  agent_name: string;
  purpose?: string;
  default_collar_id?: string;
  status: PassStatus;
  expires_at: string;
  created_at: string;
}

export type AegisPassKind = "login_password";

// Tokenized payment method capability — metadata only, no raw card data.
// Used by the runtime capability release system (playwrightRuntime, route-runs).
export interface PaymentMethodCapability {
  payment_method_id: string;
  user_id: string;
  label: string;
  network: string;
  last4: string;
  billing_country: string;
  capability_ref: string;
  created_at: string;
}

// ─── Payment Methods (user-managed vault records) ─────────────────────────────

export type PaymentMethodBrand = "visa" | "mastercard" | "amex" | "discover" | "unknown";
export type PaymentMethodStatus = "active" | "archived";

// Full payment method record stored in-process. Secret refs are internal — never returned via API.
export interface PaymentMethod {
  payment_method_id: string;
  user_id: string;
  label: string;
  cardholder_name: string;
  brand: PaymentMethodBrand;
  last4: string;
  exp_month: number;          // 1–12
  exp_year: number;           // 4-digit
  billing_zip?: string;
  billing_country?: string;
  is_default: boolean;
  status: PaymentMethodStatus;
  card_number_ref: string;    // "devvault://{id}/card_number" — encrypted blob ref, internal only
  cvv_ref: string;            // "devvault://{id}/cvv" — encrypted blob ref, internal only
  capability_ref: string;     // = payment_method_id, for runtime capability release
  created_at: string;
  updated_at: string;
}

// Safe view returned by all API responses — strips internal secret refs.
export interface PaymentMethodView {
  payment_method_id: string;
  user_id: string;
  label: string;
  cardholder_name: string;
  brand: PaymentMethodBrand;
  last4: string;
  exp_month: number;
  exp_year: number;
  billing_zip?: string;
  billing_country?: string;
  is_default: boolean;
  status: PaymentMethodStatus;
  capability_ref: string;
  created_at: string;
  updated_at: string;
}

// Dev prototype only — credential vault metadata. Secret values are stored separately in devSecretVault.
export interface AegisVaultPass {
  pass_id: string;
  user_id: string;
  label: string;
  kind: AegisPassKind;
  domain: string;
  username?: string;
  secret_ref: string;
  created_at: string;
  updated_at: string;
}

// ─── Credential Provider Model ────────────────────────────────────────────────

export interface CredentialProviderDefinition {
  provider_id: string;
  display_name: string;
  login_domains: string[];
  oauth_provider: boolean;
  aliases?: string[];
}

export interface CredentialProviderMatch {
  provider_id: string;
  display_name: string;
  matched_domain: string;
  login_domains: string[];
  oauth_provider: boolean;
  is_custom: boolean;
}

// ─── KMS Audit Events ─────────────────────────────────────────────────────────

export type KmsOperationType =
  | "encrypt_secret"
  | "decrypt_secret"
  | "rotate_key"
  | "destroy_key"
  | "resolve_secret_for_runtime";

export interface KmsAuditEvent {
  kms_audit_id: string;
  operation: KmsOperationType;
  provider: string;       // matches KmsProviderName — string avoids cross-package import
  user_id?: string;
  pass_id?: string;
  domain?: string;
  run_id?: string;
  route_id?: string;
  route_step_id?: string;
  success: boolean;
  error_code?: string;
  created_at: string;
  raw_secret_exposed: false;  // literal type — always false
}

export interface ProtectedSession {
  id: string;
  user_id: string;
  aegis_pass_id: string;
  collar_id: string;
  status: SessionStatus;
  mode: "headless" | "visible";
  current_url?: string;
  current_domain?: string;
  created_at: string;
  expires_at: string;
}

export interface ApprovalRequest {
  id: string;
  user_id: string;
  session_id: string;
  collar_id: string;
  action_type: ActionType;
  risk_level: RiskLevel;
  domain?: string;
  summary: string;
  reason: string;
  context: Record<string, unknown>;
  status: ApprovalStatus;
  created_at: string;
  resolved_at?: string;
  expires_at?: string;
}

export interface Receipt {
  id: string;
  user_id: string;
  session_id: string;
  collar_id: string;
  action_type: ActionType;
  decision: string;
  domain?: string;
  counterparty_trust_status?: string;
  reason?: string;
  outcome: string;
  sensitive_data_shared_with_agent: boolean;
  runner_task_id?: string;
  created_at: string;
}

export interface ReputationSummary {
  protected_sessions: number;
  sensitive_actions_requested: number;
  approvals_granted: number;
  approvals_denied: number;
  risky_actions_blocked: number;
  receipts_created: number;
  issues_reported: number;
  runner_tasks_completed?: number;
}

export interface AegisIDTrustClaims {
  aegis_id: string;
  verified_human_backed: boolean;
  runner_completed_purchases: number;
  blocked_risky_actions: number;
  approvals_granted: number;
  approvals_denied: number;
  credential_exposure_incidents: number;
  sensitive_data_shared_with_agent_count: number;
  purchase_history: "demo_clean" | "no_history";
  last_updated: string;
}

export type WebsiteTrustStatus = "verified_demo_business" | "unverified" | "flagged";

export interface WebsiteAegisIDTrustClaims {
  website_aegis_id: string;
  domain: string;
  business_name: string;
  trust_status: WebsiteTrustStatus;
  domain_verified: boolean;
  agent_policy_published: boolean;
  prompt_injection_reports: number;
  successful_runner_transactions: number;
  blocked_or_disputed_actions: number;
  credential_exposure_incidents: number;
  recommended_agent_action: "allow_normal_browsing" | "require_extra_approval" | "block_sensitive_actions";
  last_updated: string;
}

export type AgentTrustStatus = "demo_verified" | "limited_history" | "risk_flagged";
export type RecommendedBusinessAction =
  | "allow_with_aegis_controls"
  | "require_extra_verification"
  | "block_sensitive_interaction";

export interface AgentActivePolicySummary {
  purchase_requires_approval: boolean;
  payment_requires_approval: boolean;
  subscriptions_allowed: boolean;
  max_purchase_amount: number;
  identity_disclosure_blocked: boolean;
}

export interface AgentTrustPassport {
  aegis_id: string;
  verified_human_backed: boolean;
  trust_status: AgentTrustStatus;
  runner_completed_purchases: number;
  approvals_granted: number;
  approvals_denied: number;
  blocked_risky_actions: number;
  credential_exposure_incidents: number;
  sensitive_data_shared_with_agent_count: number;
  active_policy_summary: AgentActivePolicySummary;
  recommended_business_action: RecommendedBusinessAction;
  disclosure_level: "claims_only_no_raw_history";
  last_updated: string;
}

export interface DelegationPassport {
  passport_id: string;
  issuer: string;
  issued_at: string;
  expires_at: string;
  status: "active" | "expired" | "revoked";

  human_subject: {
    user_id: string;
    user_aegis_id: string;
    identity_level: "dev_verified" | "email_verified" | "payment_verified" | "government_id_verified";
    liability_acknowledged: boolean;
    liability_terms_version: string;
  };

  agent_subject: {
    agent_id: string;
    agent_name?: string;
    agent_platform?: string;
  };

  delegation: {
    delegation_id: string;
    collar_id?: string;
    allowed_domains?: string[];
    allowed_actions: string[];
    blocked_actions: string[];
    approval_required_for: string[];
  };

  capability_attestations: {
    login_credentials_available: boolean;
    payment_method_available: boolean;
    identity_profile_available: boolean;
    credential_domains: string[];
    max_transaction_amount_usd?: number;
  };

  secret_custody: {
    aegis_holds_user_secrets: boolean;
    agent_receives_raw_credentials: false;
    agent_receives_raw_payment_data: false;
    agent_receives_raw_identity_documents: false;
    release_model: "aegis_controlled_context_bound";
  };

  aegis_coverage_boundary: {
    covered_only_when_aegis_authorizes_and_releases_capability: true;
    covered_actions_require_controlled_runtime: true;
    covered_actions_require_sensitive_workflow_detection: true;
    covered_actions_require_signed_receipt: true;
    out_of_band_secret_use_not_covered: true;
    aegis_does_not_prove_agent_has_no_out_of_band_secrets: true;
  };

  evidence_summary: {
    verified_receipts: number;
    verified_sensitive_receipts: number;
    credential_uses: number;
    covered_sensitive_events: number;
    uncovered_sensitive_events: number;
    secrets_revealed_to_agents: number;
    policy_violations: number;
    recent_receipt_ids: string[];
  };

  verification: {
    passport_hash: string;
    passport_jws: string;
  };
}

// ─── Action Authorization Receipt ─────────────────────────────────────────────

export type AuthorizationActionType =
  | "login"
  | "credential_fill"
  | "purchase"
  | "payment"
  | "travel_booking"
  | "financial_action"
  | "identity_disclosure"
  | "account_change"
  | "destructive_action"
  | "message_send";

export type AuthorizationRiskTier = "low" | "medium" | "high" | "critical";

export interface ActionAuthorizationReceipt {
  authorization_id: string;
  issuer: string;
  issued_at: string;
  status: "active" | "fulfilled" | "revoked" | "expired";

  user_id: string;
  user_aegis_id: string;
  agent_id: string;
  delegation_id: string;
  passport_id?: string;
  passport_hash?: string;
  run_id: string;
  route_id: string;
  skill_id?: string;
  domain: string;

  action: {
    action_type: AuthorizationActionType;
    human_readable_summary: string;
    risk_tier: AuthorizationRiskTier;
    requires_user_approval: boolean;
  };

  constraints: {
    allowed_domains: string[];
    max_amount_usd?: number;
    currency?: string;
    allowed_payment_instrument_types?: string[];
    expires_at?: string;
    approval_required_for: string[];
  };

  approval: {
    approval_method: "user_click";
    approved_at: string;
    approval_ui_version: string;
    approval_text_shown: string;
    liability_terms_version: string;
    user_liability_acknowledged: boolean;
  };

  custody: {
    agent_receives_raw_credentials: false;
    agent_receives_raw_payment_data: false;
    agent_receives_raw_identity_documents: false;
    capability_release_model: "aegis_controlled_runtime";
  };

  // Populated after the associated RouteRun completes execution successfully.
  fulfillment?: {
    execution_receipt_id?: string;
    fulfilled_at?: string;
  };

  verification: {
    authorization_hash: string;
    authorization_jws: string;
  };
}

// ─── Signed User Approval Receipts v1 ────────────────────────────────────────

export type UserApprovalDecision = "approved" | "denied";
export type UserApprovalSource =
  | "approval_request"
  | "route_run_rejection"
  | "credential_authorization"              // credential injection approve path
  | "challenge_code_submission"             // security challenge code submit path
  | "payment_card_fill_authorization"       // payment card fill approve path
  | "purchase_confirmation_authorization";  // purchase confirmation approve path
export type UserApprovalOutcome = "pending" | "completed" | "failed" | "not_applicable";

/**
 * Liability-grade signed record of a user's approve/deny click at a trust boundary.
 * Produced for:
 *   - ApprovalRequest approved (approval_source: "approval_request", decision: "approved")
 *   - ApprovalRequest denied  (approval_source: "approval_request", decision: "denied")
 *   - Route-run rejected      (approval_source: "route_run_rejection", decision: "denied")
 *
 * Aegis signs user decision fields + context at decision time.
 * Workspace audit events are operational records and are separate from these receipts.
 */
export interface UserApprovalReceipt {
  receipt_id: string;              // "uar_..."
  receipt_type: "user_approval";
  schema_version: "1.0";
  issuer: "aegis";
  created_at: string;

  user_id: string;
  user_aegis_id?: string;

  delegation_id?: string;
  agent_name?: string;
  agent_platform?: string;

  collar_id?: string;
  approval_id: string;
  approval_source: UserApprovalSource;
  route_run_id?: string;
  workspace_id?: string;
  task_id?: string;

  action_type?: string;
  requested_action_summary?: string;
  target_domain?: string;
  risk_level?: "low" | "medium" | "high" | "critical";

  decision: UserApprovalDecision;
  decided_at: string;
  decision_source: "user_click";

  scope_shown?: {
    collar_name?: string;
    approval_required_actions?: string[];
    spending_limit_max_with_approval?: number;
    currency?: string;
  };

  evidence_summary?: {
    sanitized_reason?: string;
    session_id?: string;
    detection_signals_count?: number;
  };

  // Mutable outcome — excluded from canonical hash so outcome tracking doesn't break the signature.
  outcome: UserApprovalOutcome;
  outcome_updated_at?: string;

  // Privacy guarantees — literal false; never set through a variable.
  raw_secrets_in_receipt: false;
  raw_credentials_in_receipt: false;

  // Signing — excluded from hash (hash is the pre-image, jws signs the hash).
  // jws is empty string when signing key is unavailable; jws_present = false in that case.
  verification: {
    canonical_payload_hash: string;
    jws: string;
    jws_present: boolean;
    signing_alg: "EdDSA";
    signed_at: string;
    signing_key_id?: string;
  };
}

export interface UserApprovalJwsPayload {
  typ: "aegis.user_approval.v1";
  receipt_id: string;
  payload_hash: string;
  issuer: string;
  issued_at: string;
  user_id: string;
  decision: UserApprovalDecision;
  approval_id: string;
  approval_source: UserApprovalSource;
}

export interface UserApprovalReceiptVerificationResult {
  receipt_id: string;
  valid: boolean;
  hash_valid: boolean;
  signature_valid: boolean;
  recomputed_hash?: string;
  stored_hash?: string;
  jws_payload?: UserApprovalJwsPayload;
  error?: string;
}

// ─── Task-Scoped Sensitive Grants v1 ────────────────────────────────────────
// Active-authority objects created at approval time, linked to a signed UserApprovalReceipt.
// Grants are NOT signed themselves — integrity is verified via the linked UAR (linked_uar_id).
// v1 grant types: credential_injection (from CredentialUseAuthorization approval) and
// challenge_resolution (from security challenge code submission).

export type SensitiveGrantType =
  | "credential_injection"    // user approved a CredentialUseAuthorization
  | "challenge_resolution"    // user submitted a challenge code via /submit-code
  | "payment_card_fill";      // user approved a PaymentCardFillAuthorization

export type SensitiveGrantStatus =
  | "active"     // grant is live and not yet expired or consumed
  | "consumed"   // single-use grant was used
  | "expired"    // TTL elapsed before use
  | "revoked";   // explicitly invalidated by owner

export interface SensitiveGrantScope {
  user_id: string;
  delegation_id: string;
  domain: string;
  task_id?: string;             // present if approval occurred in a task context
  workspace_id?: string;
  route_run_id?: string;
  pass_id?: string;             // credential_injection only — vault pass ID, never a raw secret
  challenge_id?: string;        // challenge_resolution only — challenge ID, never the raw code
  authorization_id?: string;    // credential_injection / payment_card_fill — linked authorization ID
  payment_method_id?: string;   // payment_card_fill only — PaymentMethod.payment_method_id, never a raw value
}

export interface SensitiveGrant {
  grant_id: string;             // "sg_..."
  grant_type: SensitiveGrantType;
  schema_version: "1.0";
  issuer: "aegis";
  created_at: string;
  expires_at: string;           // copied from the linked authorization/challenge TTL

  scope: SensitiveGrantScope;

  // Required — the signed UserApprovalReceipt that authorized this grant.
  // Integrity is verified by looking up this UAR and calling verifyStoredUserApprovalReceipt.
  linked_uar_id: string;

  status: SensitiveGrantStatus;
  consumed_at?: string;
  revoked_at?: string;
  revoke_reason?: string;

  // Privacy literals — always write as the literal false, never through a variable.
  secret_exposed_to_agent: false;
  raw_credentials_in_grant: false;
}

// ─── Website Violation Receipts v1 ──────────────────────────────────────────
// Signed proof that observed website behavior violated a committed safety promise.
// Generated only for trust-boundary violations; not a general event log.
// References WebsiteTrustProfile.profile_hash as the historical promise snapshot anchor.

export type WebsiteViolationType =
  | "prompt_injection_detected"
  | "secret_request_outside_approved_flow"
  | "disguised_sensitive_action"
  | "approval_boundary_violation"
  | "unclear_sensitive_action_metadata"
  | "agent_context_exfiltration_attempt"
  | "collar_policy_override_attempt"
  | "other";

export type WebsiteViolationDecision =
  | "warned"
  | "blocked"
  | "escalated"
  | "reputation_penalized"
  | "recorded_only";

export type WebsiteViolationDetectionSource =
  | "heuristic"
  | "policy_check"
  | "manual_report"
  | "test_fixture"
  | "other";

export interface WebsiteViolationReceipt {
  receipt_id: string;                              // "wvr_..."
  receipt_type: "website_violation";
  schema_version: "1.0";
  issuer: "aegis";
  created_at: string;

  // Website identity snapshot at time of violation
  website_profile_id: string;
  website_aegis_id: string;
  domain: string;
  company_name: string;
  verification_status_at_violation: WebsiteVerificationStatus;
  profile_hash: string;                            // Promise snapshot anchor
  profile_version: string;

  // Violated promise
  violation_type: WebsiteViolationType;
  violated_promise_id: string;
  violated_promise_title: string;
  severity: "low" | "medium" | "high" | "critical";

  // Observed behavior context
  observed_at: string;
  target_url_or_origin?: string;                   // Origin only; strip query strings
  session_id?: string;
  route_run_id?: string;
  workspace_id?: string;
  task_id?: string;
  delegation_id?: string;
  agent_name?: string;
  agent_platform?: string;
  redacted_evidence_summary: string;               // Human-readable; no raw values
  evidence_hash?: string;                          // Optional SHA-256 of external evidence
  detection_source: WebsiteViolationDetectionSource;
  detection_signals_count?: number;

  // Aegis response
  decision: WebsiteViolationDecision;
  blocked_action_type?: string;
  reputation_delta?: number;
  followup_required: boolean;

  // Privacy literals — never set through a variable
  raw_secrets_in_receipt: false;
  raw_credentials_in_receipt: false;
  raw_page_content_in_receipt: false;

  // Signing — excluded from canonical hash (hash is the pre-image, jws signs the hash)
  verification: {
    canonical_payload_hash: string;
    jws: string;
    jws_present: boolean;
    signing_alg: "EdDSA";
    signed_at: string;
    signing_key_id?: string;
  };
}

export interface WebsiteViolationReceiptJwsPayload {
  typ: "aegis.website_violation.v1";
  receipt_id: string;
  payload_hash: string;
  issuer: string;
  issued_at: string;
  website_profile_id: string;
  domain: string;
  violation_type: WebsiteViolationType;
  severity: "low" | "medium" | "high" | "critical";
  decision: WebsiteViolationDecision;
}

export interface WebsiteViolationReceiptVerificationResult {
  receipt_id: string;
  valid: boolean;
  hash_valid: boolean;
  signature_valid: boolean;
  recomputed_hash?: string;
  stored_hash?: string;
  jws_payload?: WebsiteViolationReceiptJwsPayload;
  error?: string;
}

// ─── Website AegisID Trust Profiles v1 ──────────────────────────────────────
// Website/company-side declared promise snapshot for delegated-agent trust.
// WebsiteViolationReceipt.profile_hash references WebsiteTrustProfile.profile_hash.

export type WebsiteProfileStatus = "active" | "revoked" | "superseded";
export type WebsiteVerificationStatus = "unverified" | "verified" | "suspended";

export interface WebsiteAgentPolicyDeclaration {
  allowed_agent_actions: string[];
  prohibited_agent_actions: string[];
  sensitive_actions_require_aegis_approval: boolean;
  credential_handling_policy: string;
  payment_action_policy: string;
  data_usage_policy: string;
  prompt_injection_commitment: string;
  agent_safe_interaction_commitment: string;
}

export interface WebsiteSafetyPromise {
  promise_id: string;
  title: string;
  description: string;
  severity_if_violated: "low" | "medium" | "high" | "critical";
  committed: boolean;
}

export interface WebsiteTrustProfile {
  profile_id: string;            // "wtp_..."
  website_aegis_id: string;
  domain: string;
  company_name: string;
  verification_status: WebsiteVerificationStatus;
  verified_at?: string;
  profile_version: string;       // "1"
  status: WebsiteProfileStatus;
  created_at: string;
  updated_at: string;

  agent_policy: WebsiteAgentPolicyDeclaration;
  safety_promises: WebsiteSafetyPromise[];

  reputation_score?: number;
  last_reviewed_at?: string;
  violation_count: number;
  suspension_reason?: string;
  accountability_contact?: string;
  policy_url?: string;

  // Signing metadata — excluded from hash (circular/computed). JWS signs the hash.
  profile_hash: string;
  profile_jws?: string;
  jws_present: boolean;
}

export interface WebsiteTrustProfileJwsPayload {
  typ: "aegis.website_trust_profile.v1";
  profile_id: string;
  profile_hash: string;
  domain: string;
  issuer: string;
  issued_at: string;
  verification_status: WebsiteVerificationStatus;
  status: WebsiteProfileStatus;
}

export interface WebsiteTrustProfileVerificationResult {
  profile_id: string;
  valid: boolean;
  hash_valid: boolean;
  signature_valid: boolean;
  recomputed_hash?: string;
  stored_hash?: string;
  jws_payload?: WebsiteTrustProfileJwsPayload;
  error?: string;
}

export interface ApprovalManifestLineItem {
  label: string;
  value: string;
  tone?: "default" | "money" | "warning" | "success";
}

export interface ApprovalManifest {
  title: string;
  subtitle: string;
  task_category: string;
  primary_action_label: string;
  risk_tier: string;
  line_items: ApprovalManifestLineItem[];
  capabilities_to_release: string[];
  custody_guarantees: string[];
  spending_limit?: {
    max_amount_usd?: number;
    currency?: string;
    payment_instrument_label?: string;
  };
  runtime_guarantees: string[];
  website_context?: {
    domain: string;
    policy_status?: string;
    safety_recommendation?: string;
    caution_signals?: string[];
  };
  purchase_amount?: {
    amount_usd: number;
    currency: string;
    label: string;
  };
  constraint_warnings?: string[];
  approval_blocked?: boolean;
  approval_block_reason?: string;
  spending_step_up?: {
    required: boolean;
    requested_amount_usd?: number;
    approved_amount_usd?: number;
    currency?: string;
    status?: "not_requested" | "approved";
    scope?: "this_run_only";
  };
  payment_no_save?: {
    save_payment_method_allowed: false;
    subscription_allowed: false;
    default_payment_method_allowed: false;
  };
}

export interface RunApprovalContext {
  run_id: string;
  manifest: ApprovalManifest;
  skill_name?: string;
  route_name?: string;
  agent_id?: string;
  execution_surface?: string;
}

export interface PolicyEvalInput {
  collar: Collar;
  session?: ProtectedSession;
  action_type: ActionType;
  domain?: string;
  context?: Record<string, unknown>;
  counterparty_trust_status?: "unknown" | "unverified" | "domain_verified" | "business_verified" | "agent_safe" | "flagged";
}

export interface PolicyEvalResult {
  decision: PolicyDecision;
  reason: string;
  risk_level: RiskLevel;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

// ─── Aegis Rails — Route Types ────────────────────────────────────────────────

export type RouteTrustTier =
  | 'unverified_draft'
  | 'community'
  | 'aegis_scanned'
  | 'aegis_reviewed'
  | 'run_verified'
  | 'business_official';

export type ExecutionMode = 'agent_runnable' | 'aegis_controlled';
export type SensitivityLevel = 'routine' | 'sensitive';

export type StepActionType =
  | 'navigate'
  | 'click'
  | 'fill'
  | 'select'
  | 'submit'
  | 'read'
  | 'verify'
  | 'wait'
  | 'download';

// Priority order: role > label > placeholder > testid > css > xpath > coordinates
export interface RouteLocator {
  type: 'role' | 'label' | 'placeholder' | 'testid' | 'css' | 'xpath' | 'coordinates';
  role?: string;
  name?: string;
  value?: string;
  x?: number;
  y?: number;
}

export interface ElementTarget {
  preferred_locator: RouteLocator;
  fallback_locators: RouteLocator[];
  confidence: number;
  frame_path?: string[];
  shadow_root_warning?: boolean;
}

// Routes must never store raw sensitive values typed during recording.
export interface ValuePolicy {
  type: 'runtime_variable' | 'sensitive_redacted' | 'safe_literal' | 'enum_selection' | 'user_approval_required' | 'pass_field' | 'secret_ref';
  name?: string;
  value?: string;      // Only set for safe_literal and enum_selection
  pass_id?: string;    // Set when type is pass_field or secret_ref
  field?: string;      // "username" or "password"
  store_value: boolean; // Always false for sensitive_redacted, runtime_variable, pass_field, secret_ref
}

export interface ApprovalGate {
  step_id: string;
  reason: string;
  risk_level: RiskLevel;
  approval_context: string;
}

export interface RouteVariable {
  name: string;           // snake_case identifier, e.g. "month_select"
  label: string;          // Human-readable display label, e.g. "Month select"
  type: 'select' | 'text';
  default_value: string;  // Value captured during recording
  allowed_values?: string[];
  step_id: string;        // Step this variable binds to
}

export interface RouteStep {
  step_id: string;
  order: number;
  action: StepActionType;
  intent: string;
  description: string;
  target: ElementTarget;
  value_policy?: ValuePolicy;
  variable_binding?: string; // References RouteVariable.name; overrides value_policy.value at replay
  approval_required: boolean;
  confidence_required: number;
}

export interface RoutePreviewAsset {
  asset_id: string;
  kind: "start_page" | "step_frame";
  route_id: string;
  step_id?: string;
  url_path: string;
  captured_at: string;
  width?: number;
  height?: number;
  redaction_applied: boolean;
  source: "verification_replay" | "manual_capture" | "dev_seed";
}

export interface AegisRoute {
  route_id: string;
  version: string;
  created_at: string;
  last_verified_at: string;
  creator_aegis_id: string;
  trust_tier: RouteTrustTier;
  domain: string;
  workflow_name: string;
  workflow_description: string;
  risk_level: RiskLevel;
  required_permissions: ActionType[];
  allowed_actions: ActionType[];
  forbidden_actions: ActionType[];
  approval_gates: ApprovalGate[];
  confidence_threshold: number;
  steps: RouteStep[];
  variables?: RouteVariable[];
  run_count: number;
  success_rate: number;
  incident_count: number;
  verification_report?: RouteVerificationReport;
  marketplace_status?: 'private' | 'pending_review' | 'approved' | 'rejected';
  submitted_for_review_at?: string;
  reviewed_at?: string;
  review_note?: string;
  execution_mode?: ExecutionMode;
  sensitivity_level?: SensitivityLevel;
  url_match?: { hostname?: string; path_prefix?: string };
  start_url?: string;
  preview_assets?: RoutePreviewAsset[];
}

export interface Skill {
  skill_id: string;
  route_id: string;
  name: string;
  summary: string;
  domain: string;
  risk_level: string;
  trust_tier: string;
  required_permissions: string[];
  forbidden_actions: string[];
  approval_gates: ApprovalGate[];
  created_at: string;
  published_at: string;
  execution_mode?: ExecutionMode;
  sensitivity_level?: SensitivityLevel;
}

// ─── External Agent Delegation API v1 — Public Response Types ────────────────

export interface ExternalAgentIdentity {
  /** Derived from delegation.agent_name in v1 — not a globally unique durable ID. */
  agent_id: string;
  agent_name: string;
  agent_platform?: string;
  delegation_id: string;
  user_aegis_id: string;
  default_collar_id?: string;
  delegation_status: AgentDelegationStatus;
  expires_at?: string;
  /** true when the delegation has an explicitly assigned active collar. false for no-collar (baseline) and broken-collar agents. */
  collar_active: boolean;
  /** true only when the delegation has a collar assigned but it is broken or revoked. false for no-collar (baseline) and active-collar agents. */
  execution_blocked: boolean;
  /** true when no collar is assigned and the Aegis baseline safety policy is in effect. */
  baseline_policy_active?: boolean;
  /** "baseline" when running under the Aegis baseline safety policy; "collar" when an active custom collar is in use. Absent when execution is blocked. */
  policy_mode?: "collar" | "baseline";
  /** Present when collar_active is true. */
  collar_spending_limits?: {
    max_without_approval: number;
    max_with_approval: number;
  };
  token_scope: {
    skill_access_mode: SkillAccessMode;
    allowed_skill_ids?: string[];
    excluded_skill_ids?: string[];
  };
}

export interface ExternalAgentSkillSummary {
  skill_id: string;
  name: string;
  summary: string;
  domain: string;
  required_permissions: string[];
  risk_level?: string;
  trust_tier?: string;
  execution_mode?: ExecutionMode;
  sensitivity_level?: SensitivityLevel;
  /** true when the calling delegation's active collar permits this skill's required_permissions. */
  execution_available?: boolean;
}

export interface ExternalAgentRunSummary {
  run_id: string;
  skill_id: string;
  route_id: string;
  status: RouteRunStatus;
  approval_required: boolean;
  approval_required_permissions?: string[];
  created_at: string;
  completed_at?: string;
  error?: string | null;
  receipt_ids: string[];
}

export interface InstalledSkill {
  installed_skill_id: string;
  skill_id: string;
  user_id: string;
  installed_at: string;
  enabled: boolean;
}

export interface StepVerificationResult {
  step_id: string;
  order: number;
  action: StepActionType;
  locator_attempts: Array<{ locator: RouteLocator; found: boolean; error?: string }>;
  selected_locator: RouteLocator | null;
  locator_found: boolean;
  action_performed: boolean;
  passed: boolean;
  confidence: number;
  error?: string;
}

export interface RouteVerificationReport {
  route_id: string;
  started_at: string;
  completed_at: string;
  passed: boolean;
  promoted_trust_tier?: RouteTrustTier;
  step_results: StepVerificationResult[];
  errors: string[];
}

// Semantic event emitted by the recorder for each user interaction
export interface SemanticRecordingEvent {
  type: 'click' | 'fill' | 'navigate' | 'select' | 'submit' | 'download';
  url: string;
  timestamp: string;
  locators: RouteLocator[];
  raw_value?: string;       // Captured value — compiler strips this for sensitive fields
  element_type?: string;    // HTML tag name
  element_role?: string;    // ARIA role or inferred role
  autocomplete?: string;
  label_text?: string;
  placeholder?: string;
  input_name?: string;
  input_id?: string;
  input_type?: string;      // password, email, text, etc.
  aria_label?: string;
  visible_text?: string;
  nearby_text?: string;
  section_heading?: string;
  options?: string[];    // Captured <option> labels for select elements
}

export interface RecordingPayload {
  workflow_name: string;
  domain: string;
  events: SemanticRecordingEvent[];
}

// ─── Aegis Rails — RouteRunReceipt ───────────────────────────────────────────

export type AegisExecutionSurface = "chrome_extension" | "aegis_playwright";

export type RuntimeEventSensitivityKind =
  | "credential"
  | "payment"
  | "identity"
  | "financial"
  | "destructive"
  | "account_change"
  | "unknown_sensitive";

export type RuntimeEventType =
  | "sensitive_field_focus"
  | "sensitive_field_input"
  | "sensitive_button_click"
  | "sensitive_form_submit";

export type RuntimeCoverageStatus =
  | "covered_by_aegis"
  | "not_covered_by_aegis"
  | "unknown";

// The type of sensitive capability that was explicitly released by Aegis for a run.
// Coverage of a sensitive event is granted by a matching release, not by timing proximity.
export type RuntimeCapabilityType =
  | "login_credential"
  | "payment_method"
  | "identity_profile";

// Records that Aegis explicitly released a sensitive capability for use in a specific run.
// Ephemeral for v1 — copied into receipts on run completion/failure. Not persisted across restarts.
// capability_ref is an opaque ID (pass_id or payment_method_id) — never a secret value.
export interface RuntimeCapabilityRelease {
  capability_release_id: string;
  run_id: string;
  authorization_id?: string;
  authorization_hash?: string;
  user_id: string;
  domain: string;
  capability_type: RuntimeCapabilityType;
  capability_ref: string;
  task_category: string;
  route_id?: string;
  route_step_id?: string;
  constraints?: {
    max_amount_usd?: number;
    currency?: string;
    allowed_payment_instrument_types?: string[];
    allowed_domains?: string[];
  };
  released_to: "aegis_playwright_runtime";
  raw_secret_revealed_to_agent: false;
  created_at: string;
  expires_at: string;
}

export type RuntimeInterventionType =
  | "blocked_uncovered_sensitive_click"
  | "blocked_uncovered_sensitive_submit"
  | "blocked_uncovered_sensitive_input"
  | "failed_uncovered_sensitive_event"
  | "blocked_sensitive_action_without_capability_release"
  | "blocked_capability_constraint_violation";

// Created when an uncovered high/critical-severity sensitive event causes a run to be blocked.
// Metadata only — no field values, no secrets.
export interface RuntimeIntervention {
  intervention_id: string;
  runtime_session_id: string;
  run_id: string;
  user_id: string;
  domain: string;
  type: RuntimeInterventionType;
  sensitivity: RuntimeEventSensitivityKind;
  event_type: RuntimeEventType;
  page_url: string;
  element_hint?: string;
  reason: string;
  created_at: string;
  capability_type_required?: RuntimeCapabilityType;
  capability_release_present?: boolean;
}

export interface RuntimeCoverageSummary {
  sensitive_events: number;
  covered_events: number;
  uncovered_events: number;
  unknown_events: number;
  highest_severity: "info" | "warning" | "high" | "critical";
  sensitivities: RuntimeEventSensitivityKind[];
  blocked_events?: number;   // count of events that triggered a RuntimeIntervention
  interventions?: number;    // count of RuntimeInterventions created for this session
}

export interface RouteRunReceipt {
  receipt_id: string;
  run_id: string;
  skill_id: string;
  route_id: string;
  installed_skill_id: string;
  user_id: string;
  agent_id?: string;
  domain: string;
  status: "completed" | "failed";
  variables?: Record<string, string>;
  allowed_reason: string;
  execution_surface: AegisExecutionSurface;
  route_trust_tier: string;
  skill_name: string;
  route_name: string;
  created_at: string;
  completed_at?: string;
  error?: string;
  credential_used?: boolean;
  pass_ids_used?: string[];
  secret_values_revealed_to_agent?: false;
  runtime_coverage_summary?: RuntimeCoverageSummary;
  runtime_interventions?: RuntimeIntervention[];
  runtime_capability_releases?: RuntimeCapabilityRelease[];
  capability_release_summary?: {
    releases_created: number;
    login_credential_releases: number;
    payment_method_releases: number;
    identity_profile_releases: number;
    raw_secret_revealed_to_agent: false;
  };
  authorization_context?: {
    authorization_id: string;
    authorization_hash: string;
    passport_id?: string;
    passport_hash?: string;
  };
  observation_mode_summary?: RuntimeObservationModeState;
  task_browser_session_id?: string;
  agent_summary?: string;
}

// ─── Sensitive Workflow Observation Mode v1 ───────────────────────────────────

export type RuntimeObservationMode =
  | "open_observation"
  | "protected_observation";

export type RuntimeObservationActivationReason =
  | "route_marked_sensitive"
  | "required_permission_sensitive"
  | "sensitive_url_detected"
  | "sensitive_dom_detected"
  | "sensitive_action_detected"
  | "collar_policy_requires_protection"
  | "website_policy_requires_protection";

export interface RuntimeObservationModeState {
  mode: RuntimeObservationMode;
  activated_at?: string;
  activation_reasons: RuntimeObservationActivationReason[];
  sensitive_signals: string[];
}

export type AgentSafeElementKind =
  | "field"
  | "button"
  | "link"
  | "text"
  | "form"
  | "other";

export interface AgentSafeObservationElement {
  element_id: string;
  kind: AgentSafeElementKind;
  role?: string;
  label?: string;
  text?: string;
  placeholder?: string;
  input_type?: string;
  sensitive: boolean;
  sensitivity?: RuntimeEventSensitivityKind;
  required_capability?: RuntimeCapabilityType;
  value_redacted?: boolean;
  value?: string;
  filled?: boolean;
  allowed_actions: Array<"read" | "fill" | "click" | "request_fill" | "request_click" | "none">;
  reason?: string;
}

export interface AgentSafeObservationSnapshot {
  snapshot_id: string;
  runtime_session_id: string;
  run_id?: string;
  user_id: string;
  domain: string;
  page_url: string;
  created_at: string;
  observation_mode: RuntimeObservationModeState;
  elements: AgentSafeObservationElement[];
  summary: {
    total_elements: number;
    sensitive_elements: number;
    redacted_values: number;
    required_capabilities: RuntimeCapabilityType[];
  };
}

// ─── Observation Dry Run v1 ───────────────────────────────────────────────────

export type ObservationDryRunStatus = "completed" | "failed";

export type ObservationDryRunRecommendation =
  | "safe_to_observe"
  | "sensitive_surface_detected"
  | "do_not_execute_without_aegis_route"
  | "blocked_by_navigation_error";

export interface ObservationDryRunSensitiveSurface {
  kind: AgentSafeElementKind;
  label?: string;
  text?: string;
  input_type?: string;
  sensitivity?: RuntimeEventSensitivityKind;
  required_capability?: RuntimeCapabilityType;
  reason: string;
}

export interface ObservationDryRunOpenSummary {
  page_title?: string;
  headings: string[];
  links_sample: string[];
  buttons_sample: string[];
  forms_detected: number;
}

export interface ObservationDryRunResult {
  dry_run_id: string;
  status: ObservationDryRunStatus;
  requested_url: string;
  final_url?: string;
  domain?: string;
  task_category?: DelegationTrustTaskCategory;
  created_at: string;
  completed_at?: string;
  recommendation: ObservationDryRunRecommendation;
  observation_mode: RuntimeObservationModeState;
  open_summary?: ObservationDryRunOpenSummary;
  snapshot?: AgentSafeObservationSnapshot;
  sensitive_surfaces: ObservationDryRunSensitiveSurface[];
  summary: {
    total_elements: number;
    sensitive_elements: number;
    redacted_values: number;
    required_capabilities: RuntimeCapabilityType[];
    navigation_ms?: number;
  };
  safety_rules_enforced: {
    no_clicks: true;
    no_typing: true;
    no_form_submit: true;
    no_credential_fill: true;
    no_payment_release: true;
    no_kms_decrypt: true;
    no_route_execution: true;
    no_screenshot: true;
    no_full_dom_dump: true;
  };
  error?: { code: string; message: string };
}

// ─── Aegis Rails — RoutePassBinding ──────────────────────────────────────────

// Binds a specific vault pass to a route for a given purpose.
// Overrides the default pass_id in route step value_policy at resolve-value time.
export interface RoutePassBinding {
  binding_id: string;
  user_id: string;
  route_id: string;
  pass_id: string;
  purpose: "login_password";
  created_at: string;
  updated_at: string;
}

// ─── Aegis Rails — RouteRun ───────────────────────────────────────────────────

export type RouteRunStatus = "pending" | "pending_approval" | "running" | "completed" | "failed" | "blocked";

export interface RouteRun {
  run_id: string;
  skill_id: string;
  route_id: string;
  installed_skill_id: string;
  agent_id?: string;
  user_id: string;
  domain: string;
  status: RouteRunStatus;
  variables?: Record<string, string>;
  pass_overrides?: Record<string, string>;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  error?: string;
  delegation_id?: string;
  collar_id?: string;
  approval_required_permissions?: string[];
  approved_at?: string;
  approved_permissions?: string[];
  credential_used?: boolean;
  pass_ids_used?: string[];
  secret_values_revealed_to_agent?: false;
  // Set when an execution surface claims the run before starting it.
  // Prevents other surfaces (e.g. Chrome extension) from racing.
  claimed_execution_surface?: AegisExecutionSurface;
  authorization_id?: string;
  authorization_hash?: string;
  task_browser_session_id?: string;
}

// ─── Aegis Action API — Decision Types ────────────────────────────────────────

export type ActionDecision = 'allow' | 'block' | 'approval_required' | 'pause';

// Broad risk categories used to classify route step actions for collar enforcement
export type ActionRiskCategory =
  | 'browse'
  | 'read'
  | 'fill_form'
  | 'download_file'
  | 'submit_form'
  | 'purchase'
  | 'money_movement'
  | 'account_setting_change'
  | 'external_message'
  | 'delete_data';

export interface ActionRequest {
  agent_id?: string;
  session_id: string;
  route_id: string;
  requested_action: {
    type: string;            // Must match the StepActionType of the target step
    step_id: string;
    target_locator: RouteLocator;
  };
  // Demo-only override: allows unverified_draft routes to proceed on localhost
  allow_draft_route?: boolean;
}

export interface ActionDecisionResponse {
  decision: ActionDecision;
  reason: string;
  route_id: string;
  step_id: string;
  session_id: string;
  risk_category: ActionRiskCategory;
  matched_locator: RouteLocator | null;
  approval_context?: string;
  // TODO: wire to ReceiptService when the audit layer is built
  audit_event_id: string | null;
}

// ─── Delegation Trust Profile ─────────────────────────────────────────────────

export type DelegationTrustTaskCategory =
  | "login"
  | "credential_fill"
  | "purchase"
  | "payment"
  | "travel_booking"
  | "financial_action"
  | "identity_disclosure"
  | "account_change"
  | "destructive_action"
  | "message_send";

export type DelegationTrustStatus =
  | "unproven"
  | "capable_but_unproven"
  | "proven_limited"
  | "trusted_for_category"
  | "caution"
  | "risky"
  | "suspended";

export interface DelegationTrustProfile {
  profile_id: string;
  generated_at: string;
  delegation_id: string;
  user_aegis_id: string;
  agent_id: string;
  requested_task_category: DelegationTrustTaskCategory;

  trust_status: DelegationTrustStatus;
  confidence: "low" | "medium" | "high";

  capability_summary: {
    login_credentials_available: boolean;
    payment_method_available: boolean;
    identity_profile_available: boolean;
    credential_domains: string[];
    capable_for_requested_task: boolean;
    missing_capabilities: string[];
  };

  coverage_summary: {
    verified_execution_receipts: number;
    verified_authorizations: number;
    covered_sensitive_events: number;
    uncovered_sensitive_events: number;
    secret_exposure_events: number;
    aegis_playwright_executions: number;
  };

  category_experience: {
    category: DelegationTrustTaskCategory;
    fulfilled_authorizations: number;
    verified_execution_receipts: number;
    recent_successful_receipt_ids: string[];
  };

  disqualifying_signals: string[];
  machine_readable_reasons: string[];

  limitations: {
    not_a_guarantee: true;
    out_of_band_secret_use_not_covered: true;
    based_only_on_aegis_observed_events: true;
  };
}

export interface WebsiteTrustAssertion {
  assertion_id: string;
  issuer: string;
  issued_at: string;
  expires_at: string;

  requesting_website: {
    domain: string;
    origin?: string;
    verification_level: "dev_localhost" | "domain_observed" | "domain_verified" | "business_verified";
  };

  subject: {
    user_aegis_id: string;
    agent_id: string;
    delegation_id: string;
    passport_id?: string;
    passport_hash?: string;
  };

  requested_task: {
    category: DelegationTrustTaskCategory;
    domain: string;
    human_readable_summary?: string;
  };

  decision: {
    recommendation: "allow" | "allow_with_approval" | "step_up_required" | "deny";
    trust_status: DelegationTrustStatus;
    confidence: "low" | "medium" | "high";
    reasons: string[];
    disqualifying_signals: string[];
  };

  capability_summary: DelegationTrustProfile["capability_summary"];
  coverage_summary: DelegationTrustProfile["coverage_summary"];
  limitations: DelegationTrustProfile["limitations"];

  verification: {
    assertion_hash: string;
    assertion_jws: string;
  };
}

// ─── Website Agent-Safety Profile ────────────────────────────────────────────

export type WebsiteVerificationLevel =
  | "dev_localhost"
  | "domain_observed"
  | "domain_verified"
  | "business_verified";

export type WebsiteAgentSafetyStatus =
  | "unknown"
  | "agent_callable"
  | "agent_callable_with_approval"
  | "step_up_required"
  | "unsafe"
  | "blocked";

// Deterministic profile describing whether a domain is safe for agent interaction
// for a specific task category. Based only on Aegis-observed signals — not a
// business verification or guarantee of safe behavior.
export interface WebsiteAgentSafetyProfile {
  profile_id: string;
  generated_at: string;
  domain: string;
  requested_task_category: DelegationTrustTaskCategory;
  website_verification_level: WebsiteVerificationLevel;
  agent_safety_status: WebsiteAgentSafetyStatus;
  recommendation: "allow" | "allow_with_approval" | "step_up_required" | "deny";
  confidence: "low" | "medium" | "high";

  capabilities: {
    has_known_routes: boolean;
    supported_task_categories: DelegationTrustTaskCategory[];
    has_sensitive_workflow_support: boolean;
    supports_aegis_controlled_runtime: boolean;
    supports_agent_safe_observation: boolean;
    supports_capability_release_gate: boolean;
  };

  safety_signals: {
    verified_successful_receipts: number;
    failed_violation_receipts: number;
    uncovered_sensitive_events: number;
    runtime_interventions: number;
    secret_exposure_events: number;
    protected_observation_sessions: number;
    clean_sensitive_runs: number;
  };

  website_legibility: {
    has_structured_route_metadata: boolean;
    has_known_start_url: boolean;
    has_known_sensitive_actions: boolean;
    has_policy_source: boolean;
    policy_source?: "seeded_demo" | "route_metadata" | "well_known" | "manual_review";
  };

  task_fit: {
    category: DelegationTrustTaskCategory;
    matching_routes: string[];
    required_capabilities: RuntimeCapabilityType[];
    known_constraints: string[];
  };

  disqualifying_signals: string[];
  machine_readable_reasons: string[];

  limitations: {
    not_business_verified: boolean;
    no_live_crawl_performed: true;
    based_only_on_aegis_observed_events: true;
    not_a_guarantee: true;
  };
}

// ─── Website .well-known Aegis Policy ─────────────────────────────────────────

export type WebsiteAegisAgentAccess =
  | "not_supported"
  | "allowed_with_aegis"
  | "allowed_with_approval"
  | "restricted"
  | "blocked";

export interface WebsiteAegisPolicyWorkflow {
  workflow_id: string;
  name: string;
  task_category: DelegationTrustTaskCategory;
  path_prefixes: string[];
  required_capabilities: RuntimeCapabilityType[];
  requires_user_approval: boolean;
  max_amount_usd?: number;
  currency?: string;
  allowed_payment_instrument_types?: string[];
  prohibited_capabilities?: RuntimeCapabilityType[];
  prohibited_actions?: string[];
  support_path?: string;
  refund_policy?: string;
  dispute_policy?: string;
  notes?: string;
}

export interface WebsiteAegisPolicy {
  version: "aegis-policy-v1";
  domain: string;
  issued_at: string;
  agent_access: WebsiteAegisAgentAccess;
  verification_level: WebsiteVerificationLevel;
  policy_source: "well_known" | "seeded_demo" | "manual_review";
  supported_workflows: WebsiteAegisPolicyWorkflow[];
  global_prohibited_actions: string[];
  required_assertions: Array<
    | "delegation_passport_v1"
    | "website_trust_assertion_v1"
    | "action_authorization_receipt_v1"
  >;
  contact?: {
    support_url?: string;
    security_url?: string;
    terms_url?: string;
  };
  limitations: {
    not_business_verified: boolean;
    self_asserted_policy: true;
    not_a_guarantee: true;
  };
}

export interface WebsiteAegisPolicyValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  policy?: WebsiteAegisPolicy;
}

export interface WebsitePolicyCompatibilityResult {
  compatible: boolean;
  recommendation: "allow" | "allow_with_approval" | "step_up_required" | "deny";
  reasons: string[];
  mismatches: string[];
  required_capabilities: RuntimeCapabilityType[];
  required_assertions: string[];
  matching_workflows: string[];
}

// ─── Authenticated Session Boundary v1 ───────────────────────────────────────

export type AuthenticatedSessionStatus =
  | "pending_approval"
  | "login_in_progress"
  | "authenticated"
  | "manual_step_required"
  | "failed"
  | "expired";

export type AuthenticatedSessionCapability =
  | "authenticated_observation"
  | "safe_navigation";

export interface AuthenticatedSessionLoginDiagnostics {
  attempted: boolean;
  started_at?: string;
  completed_at?: string;
  // Credential metadata — booleans only, never values
  credential_found: boolean;
  username_present: boolean;   // vault pass has a non-empty username
  password_present: boolean;   // KMS decrypt produced a non-empty string
  // Fill and submit outcomes
  username_fill_attempted: boolean;
  username_fill_succeeded: boolean;
  password_fill_attempted: boolean;
  password_fill_succeeded: boolean;
  submit_attempted: boolean;
  submit_succeeded: boolean;
  // Post-submit state
  post_submit_url?: string;
  post_submit_wait_ms?: number;
  post_submit_url_transitions?: string[];
  // Verification outcome
  verification_authenticated: boolean;
  verification_reason?: string;
  // Challenge detection
  challenge_detected?: boolean;
  challenge_reason?: string;
  // Safe page-level failure text — UI banners/alerts only, never input values or secrets
  failure_evidence?: string[];
}

export interface AuthenticatedSessionHandle {
  session_id: string;
  user_id: string;
  delegation_id: string;
  domain: string;
  login_url: string;
  task_summary: string;
  status: AuthenticatedSessionStatus;
  capabilities: AuthenticatedSessionCapability[];
  // Literal false — Aegis never exposes cookies, storage, or credentials to the agent
  raw_cookies_revealed_to_agent: false;
  raw_storage_revealed_to_agent: false;
  raw_credentials_revealed_to_agent: false;
  manual_step_reason?: string;
  login_diagnostics?: AuthenticatedSessionLoginDiagnostics;
  initial_observation?: ObservationDryRunOpenSummary;
  created_at: string;
  expires_at: string;
  /** Set when the session borrowed an existing task browser session instead of launching a fresh browser. */
  task_browser_session_id?: string;
}

export interface AuthenticatedSessionLoginRequest {
  domain: string;
  login_url: string;
  task_summary: string;
  pass_id?: string;
  /** Optional. If provided, the authenticated session will borrow this task browser session
   *  (via CDP) instead of launching a new isolated headless browser. The task browser is
   *  NOT closed when the authenticated session ends — only Aegis's page is closed. */
  browser_session_id?: string;
}

export interface AuthenticatedSessionObserveResult {
  session_id: string;
  status: AuthenticatedSessionStatus;
  page_url: string;
  open_summary?: ObservationDryRunOpenSummary;
  protected_snapshot?: AgentSafeObservationSnapshot;
  manual_step_reason?: string;
  raw_cookies_revealed_to_agent: false;
  raw_storage_revealed_to_agent: false;
}

export interface AuthenticatedSessionNavigateRequest {
  url: string;
}

// ─── Agent-Browser Secret Injection v1 ───────────────────────────────────────

export type SecretFieldInjectionStatus =
  | "pending_approval"
  | "approved"
  | "executing"
  | "filled"
  | "denied"
  | "failed"
  | "expired";

export interface SecretFieldInjectionElementHint {
  label?: string;
  placeholder?: string;
  input_type?: string;
  selector_hint?: string;
}

export interface SecretFieldInjection {
  injection_request_id: string;
  user_id: string;
  delegation_id: string;
  domain: string;
  field_kind: "username" | "password";
  pass_id: string;
  page_url: string;
  element_hint?: SecretFieldInjectionElementHint;
  reason: string;
  status: SecretFieldInjectionStatus;
  authorization_id?: string;
  browser_session_id?: string;
  external_cdp_url?: string;
  raw_value_revealed_to_agent: false;
  created_at: string;
  expires_at: string;
  approved_at?: string;
  filled_at?: string;
  error?: string;
}

export type CredentialUseAuthorizationStatus =
  | "pending_approval"
  | "approved"
  | "fulfilled"
  | "denied"
  | "expired"
  | "revoked";

export interface CredentialUseAuthorization {
  authorization_id: string;
  user_id: string;
  delegation_id: string;
  domain: string;
  pass_id: string;
  pass_label: string;
  pass_username?: string;
  allowed_field_kinds: Array<"username" | "password">;
  max_uses_per_field: { username?: number; password?: number };
  purpose: "login";
  status: CredentialUseAuthorizationStatus;
  raw_values_revealed_to_agent: false;
  persistence_allowed: false;
  browser_storage_allowed: false;
  website_save_allowed: false;
  created_at: string;
  expires_at: string;
  approved_at?: string;
  fulfilled_at?: string;
  last_used_at?: string;
  used_field_kinds: Array<"username" | "password">;
  use_counts: { username: number; password: number };
}

// ─── Credential Step Handoff v1 ──────────────────────────────────────────────

export type CredentialStepHandoffStatus =
  | "step_completed"
  | "navigated"
  | "challenge_detected"
  | "invalid_credentials"
  | "submit_failed"
  | "manual_step_required"
  | "blocked_policy";

export type CredentialStepKind =
  | "username_next"
  | "password_submit";

export interface CredentialStepHandoffResult {
  handoff_id: string;
  status: CredentialStepHandoffStatus;
  step_kind: CredentialStepKind;
  domain: string;
  completed_at: string;
  raw_value_revealed_to_agent: false;
  current_url?: string;
  page_title?: string;
  challenge_kind?: "totp" | "email_code" | "sms_code" | "captcha" | "unknown";
  signals_detected?: string[];
  blocked_reason?: string;
  next_action?: {
    recommended: "report_security_challenge" | "retry_login" | "stop_and_ask_user";
    reason: string;
  };
}

// ─── Login Failure Diagnostics v1 ────────────────────────────────────────────

export type LoginOutcomeCode =
  | "login_success"
  | "invalid_credentials"
  | "manual_challenge_required"
  | "captcha_required"
  | "rate_limited"
  | "unknown_failure";

export interface LoginOutcome {
  outcome: LoginOutcomeCode;
  failure_reason?: string;
  user_message: string;
  recommended_action: string;
  signals_detected: string[];
  related_pass_id?: string;
  browser_session_id?: string;
  raw_secret_revealed_to_agent: false;
}

export interface StoredLoginDiagnostic {
  diagnostic_id: string;
  user_id: string;
  browser_session_id: string;
  delegation_id?: string;
  domain: string;
  pass_label?: string;
  related_pass_id?: string;
  outcome: LoginOutcomeCode;
  user_message: string;
  recommended_action: string;
  failure_reason?: string;
  signals_detected: string[];
  detected_at: string;
  raw_secret_revealed_to_agent: false;
}

// ─── Challenge Relay v1 ──────────────────────────────────────────────────────

export type SecurityChallengeType =
  | "email_device_verification"
  | "sms_code"
  | "totp"
  | "passkey"
  | "captcha"
  | "device_verification"
  | "unknown";

export type SecurityChallengeStatus =
  | "pending_user"
  | "code_submitted"
  | "code_injected"
  | "user_completed"
  | "cancelled"
  | "expired"
  | "failed";

export interface SecurityChallengeElementHint {
  label?: string;
  placeholder?: string;
  input_type?: string;
  selector_hint?: string;
}

export interface SecurityChallenge {
  challenge_id: string;
  user_id: string;
  delegation_id: string;
  browser_session_id?: string;
  domain: string;
  page_url: string;
  challenge_type: SecurityChallengeType;
  status: SecurityChallengeStatus;
  masked_destination?: string;
  element_hint?: SecurityChallengeElementHint;
  instructions: string;
  // Literal false — the raw verification code is never returned to the agent
  raw_code_revealed_to_agent: false;
  created_at: string;
  expires_at: string;
  submitted_at?: string;
  injected_at?: string;
  completed_at?: string;
  error?: string;
}

// ─── Connected Email Challenge Resolver v1 ────────────────────────────────────

export type ChallengeEmailResolutionStatus =
  | "pending_approval"
  | "searching"        // Reserved for future async path — not used in v1
  | "code_found"
  | "injected"
  | "not_found"
  | "failed"
  | "expired"
  | "cancelled";

export type ChallengeEmailSearchErrorCode =
  | "GMAIL_RECONNECT_REQUIRED"
  | "GMAIL_SEARCH_UNAVAILABLE";

export interface ChallengeEmailResolution {
  resolution_id: string;
  challenge_id: string;
  user_id: string;
  delegation_id: string;
  provider: "gmail";
  domain: string;
  status: ChallengeEmailResolutionStatus;
  // Literal false — raw code is never returned to the agent
  raw_code_revealed_to_agent: false;
  // Literal false — email body is never returned to the agent
  email_body_revealed_to_agent: false;
  // = challenge.created_at — only emails received after this point are considered
  search_window_started_at: string;
  searched_at?: string;
  found_at?: string;
  injected_at?: string;
  // Domain of the sender (e.g. "github.com") — never full sender name or email
  sender_domain?: string;
  // ISO timestamp of the matched email
  received_at?: string;
  /** Safe metadata: which phase found the code — never contains the code or email text. */
  extraction_source?: "subject_snippet" | "body_text";
  error?: string;
  /** Stable code for the frontend to branch on — not raw OAuth error details */
  email_search_error_code?: ChallengeEmailSearchErrorCode;
  /** Always true when status is "failed" — manual entry is always the fallback */
  manual_entry_available?: true;
  created_at: string;
  updated_at: string;
}

// ─── Task Browser Lifecycle v1 ────────────────────────────────────────────────

export type TaskBrowserSessionStatus =
  | "starting"
  | "ready"
  | "closed"
  | "failed"
  | "expired";

export interface TaskBrowserSession {
  browser_session_id: string;
  user_id: string;
  delegation_id?: string;
  status: TaskBrowserSessionStatus;
  cdp_url: string;          // e.g. "http://localhost:9222" — localhost only
  cdp_port: number;
  user_data_dir: string;    // /tmp/aegis-agent-browser-<id> — local path, not a secret
  ephemeral: true;
  mode: "headless" | "visible";
  debug_visible: boolean;
  created_at: string;
  expires_at: string;
  closed_at?: string;
  error?: string;
  cleanup_complete?: boolean;
  /** Distinguishes auto-provisioned runtimes from manually started compatibility sessions. */
  runtime_mode?: "local_runtime_endpoint" | "compatibility_bridge";
}

// ─── Payment Card Fill Handoff v1 ────────────────────────────────────────────
// Card fill approval + CDP field injection.
// Does NOT cover purchase confirmation — that is a separate, unimplemented feature.

export type PaymentCardField =
  | "card_number"       // KMS-resolved from card_number_ref — value never returned to agent
  | "cvv"               // KMS-resolved from cvv_ref — value never returned to agent
  | "expiry_month"      // pm.exp_month — cleartext non-secret metadata
  | "expiry_year"       // pm.exp_year — cleartext non-secret metadata
  | "expiry_combined"   // "MM/YY" derived — cleartext non-secret metadata
  | "cardholder_name"   // pm.cardholder_name — cleartext non-secret metadata
  | "billing_zip";      // pm.billing_zip — cleartext non-secret metadata

export type PaymentCardFillAuthorizationStatus =
  | "pending_approval"
  | "approved"
  | "fulfilled"
  | "denied"
  | "expired"
  | "revoked";

export type PaymentCardFillRequestStatus =
  | "pending_approval"
  | "approved"
  | "executing"
  | "filled"
  | "denied"
  | "failed"
  | "expired";

export interface PaymentCardFillElementHint {
  label?: string;
  placeholder?: string;
  input_type?: string;
  /** CSS selector targeting only the input field. Must not target button, submit, form, or a[href] elements. Validated at creation time. */
  selector_hint?: string;
}

/** One user approval covering all requested card field fills for a single domain/payment-method combination. */
export interface PaymentCardFillAuthorization {
  authorization_id: string;            // "pca_..."
  user_id: string;
  delegation_id: string;
  domain: string;
  /** Internal identifier — never exposed in agent-facing API responses. */
  payment_method_id: string;
  payment_method_label: string;
  last4: string;
  is_default: boolean;
  allowed_fields: PaymentCardField[];
  /** Populated as each field is successfully filled. */
  fields_filled: PaymentCardField[];
  status: PaymentCardFillAuthorizationStatus;
  /** Always the literal false — raw card values are never returned to the agent. */
  raw_values_revealed_to_agent: false;
  /** Always the literal true — approving this does not authorize any purchase action. */
  purchase_not_authorized: true;
  created_at: string;
  expires_at: string;
  approved_at?: string;
  fulfilled_at?: string;
}

/** A single card field fill request linked to a PaymentCardFillAuthorization. */
export interface PaymentCardFillRequest {
  fill_request_id: string;             // "pcfr_..."
  authorization_id: string;
  user_id: string;
  delegation_id: string;
  domain: string;
  /** Internal identifier — never exposed in agent-facing API responses. */
  payment_method_id: string;
  field: PaymentCardField;
  page_url: string;
  element_hint?: PaymentCardFillElementHint;
  reason: string;
  status: PaymentCardFillRequestStatus;
  browser_session_id?: string;
  external_cdp_url?: string;
  /** Always the literal false — raw card values are never returned to the agent. */
  raw_values_revealed_to_agent: false;
  created_at: string;
  expires_at: string;
  approved_at?: string;
  filled_at?: string;
  error?: string;
}

/** Returned by execute endpoint — safe metadata only, no raw card values. */
export interface PaymentCardFillResult {
  fill_request_id: string;
  authorization_id: string;
  status: "filled" | "failed";
  field: PaymentCardField;
  domain: string;
  payment_method_label: string;
  last4: string;
  filled_at?: string;
  /** Always the literal false — raw card values are never returned to the agent. */
  raw_values_revealed_to_agent: false;
  /** Always the literal true — filling card fields does not authorize any purchase. */
  purchase_not_authorized: true;
  note: string;
  error?: string;
}

// ─── Purchase Confirmation Handoff v1 ─────────────────────────────────────────
// Separate approval and execution for final payment submission.
// Never reuses PaymentCardFillAuthorization — that covers field fill only.

export type PurchaseConfirmationAuthorizationStatus =
  | "pending_approval"
  | "approved"
  | "fulfilled"
  | "denied"
  | "expired"
  | "revoked";

export type PurchaseConfirmationOutcome =
  | "submitted"
  | "failed"
  | "blocked_merchant_mismatch"
  | "blocked_policy"
  | "manual_step_required";

/** One separate user approval covering final payment button click. Distinct from PaymentCardFillAuthorization. */
export interface PurchaseConfirmationAuthorization {
  purchase_confirmation_id: string;   // "pconf_..."
  user_id: string;
  delegation_id: string;
  domain: string;
  page_url: string;
  merchant: string;
  amount?: number;
  currency: string;
  /** true when the agent could not determine the amount — UI must show a strong warning. */
  amount_unknown: boolean;
  item_summary: string;
  payment_method_label: string;
  payment_method_last4: string;
  /** The exact button text that will be clicked when approved. */
  button_text: string;
  button_selector_hint?: string;
  /** Optional back-reference to the preceding card fill approval, for audit trail. */
  card_fill_authorization_id?: string;
  reason: string;
  status: PurchaseConfirmationAuthorizationStatus;
  risk_level: "high" | "critical";
  /** Always the literal false — raw card values are never involved in this flow. */
  raw_values_revealed_to_agent: false;
  /** false until the user explicitly approves; true only after approval. */
  purchase_action_authorized: boolean;
  created_at: string;
  expires_at: string;
  approved_at?: string;
  fulfilled_at?: string;
}

/** Audit record for a completed purchase confirmation handoff. Never stores card values or KMS material. */
export interface PurchaseConfirmationHandoffRecord {
  handoff_id: string;                    // "pchoff_..."
  purchase_confirmation_id: string;
  user_id: string;
  delegation_id: string;
  domain: string;
  merchant: string;
  amount?: number;
  currency: string;
  item_summary: string;
  payment_method_label: string;
  payment_method_last4: string;
  button_text: string;
  outcome: PurchaseConfirmationOutcome;
  card_fill_authorization_id?: string;
  /** Always the literal false. */
  raw_values_revealed_to_agent: false;
  completed_at: string;
}

// ─── Sensitive Action Receipt Timeline v1 ──────────────────────────────────────

export type SensitiveActionEventType =
  | "task_browser_session_started"
  | "task_browser_session_closed"
  | "credential_authorization_approved"
  | "credential_authorization_fulfilled"
  | "secret_field_injected"
  | "credential_step_handoff_executed"
  | "security_challenge_reported"
  | "challenge_code_submitted_manual"
  | "challenge_code_injected"
  | "challenge_email_resolution_requested"
  | "challenge_email_code_found"
  | "challenge_email_code_injected"
  | "payment_card_fill_executed"
  | "purchase_confirmation_submitted"
  | "purchase_confirmation_failed";

export interface SensitiveActionTimelineItem {
  item_id: string;
  event_type: SensitiveActionEventType;
  timestamp: string;
  domain?: string;
  description: string;
  metadata: Record<string, string | boolean | number>;
  privacy_guarantees: string[];
  browser_session_id?: string;
  authorization_id?: string;
  challenge_id?: string;
  resolution_id?: string;
  purchase_confirmation_id?: string;
}

// ─── Aegis Workspaces v0 ────────────────────────────────────────────────────

export type WorkspaceStatus = "active" | "archived";
export type WorkspaceTaskStatus = "open" | "in_progress" | "completed" | "cancelled";
export type WorkspaceArtifactKind = "text" | "json" | "csv" | "markdown" | "file";
export type TaskKind =
  | "research"
  | "analysis"
  | "draft"
  | "review"
  | "shopping"
  | "coding"
  | "planning"
  | "approval_prep"
  | "execution"
  | "other";
export type TaskMode = "direct" | "plan_first";
export type TaskPriority = "low" | "normal" | "high" | "urgent";

/** A shared, permissioned context where multiple delegated agents coordinate. */
export interface AegisWorkspace {
  workspace_id: string;
  owner_user_id: string;
  name: string;
  description?: string;
  /** Workspace collar governs agent access. Must be active. */
  collar_id: string;
  /** Delegations with read/write access to this workspace. */
  participant_delegation_ids: string[];
  status: WorkspaceStatus;
  created_at: string;
  updated_at: string;
}

/** A task within a workspace that agents can claim and complete. */
export interface WorkspaceTask {
  task_id: string;
  workspace_id: string;
  title: string;
  description?: string;
  status: WorkspaceTaskStatus;
  /**
   * Eligibility mode for this task. Missing or undefined is treated as "open".
   *   "open"       — any participant with workspace_task_claim permission may claim
   *   "delegation" — only the delegation whose id matches assigned_delegation_id may claim
   *   "collar"     — only a delegation whose default_collar_id matches required_collar_id may claim
   */
  assignment_type?: "open" | "delegation" | "collar";
  /**
   * Dual role:
   *   assignment_type="delegation" + status="open"  → the delegation reserved for this task
   *   status="in_progress" (any type)               → the delegation that claimed this task
   */
  assigned_delegation_id?: string;
  /** Only meaningful when assignment_type="collar". The collar ID the claiming delegation must carry. */
  required_collar_id?: string;
  /** Categorizes the nature of work. Advisory — used for manifest guidance. Default: "other". */
  task_kind?: TaskKind;
  /** Workflow hint for the claiming agent. "plan_first" = draft an approach before executing. Advisory only. */
  task_mode?: TaskMode;
  /** Scheduling priority. Default: "normal". */
  priority?: TaskPriority;
  /** Task IDs whose status must be "completed" before this task is considered ready. */
  depends_on_task_ids?: string[];
  /** Artifact names that must exist in the workspace before this task is considered ready. */
  required_artifact_names?: string[];
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

interface WorkspaceArtifactBase {
  artifact_id: string;
  workspace_id: string;
  name: string;
  task_id?: string;
  created_by_delegation_id?: string;
  created_at: string;
}

/** Text artifact (text/json/csv/markdown) produced within a workspace. */
export interface WorkspaceTextArtifact extends WorkspaceArtifactBase {
  kind: "text" | "json" | "csv" | "markdown";
  content: string;
}

/** File artifact uploaded by a workspace owner. Binary stored on disk; metadata only in JSON store. */
export interface WorkspaceFileArtifact extends WorkspaceArtifactBase {
  kind: "file";
  mime_type: string;
  size_bytes: number;
  /** Absolute path on API server disk. Never returned in API responses. */
  local_path: string;
  content?: never;
}

export type WorkspaceArtifact = WorkspaceTextArtifact | WorkspaceFileArtifact;

export type TaskEligibilityLabel = "eligible" | "not_eligible" | "assigned_to_me" | "open";
export type TaskReadinessLabel =
  | "ready"
  | "blocked"
  | "in_progress_mine"
  | "in_progress_other"
  | "completed"
  | "cancelled";
export type TaskRecommendedAction =
  | "claim"
  | "continue_work"
  | "wait"
  | "read_artifact"
  | "complete_when_done"
  | "none";

export interface TaskBlockerReasons {
  incomplete_dependency_task_ids?: string[];
  missing_artifact_names?: string[];
  claimed_by_other?: boolean;
  not_eligible_reason?: string;
}

/** Per-task enriched entry in the recommended_work_queue returned by the manifest. */
export interface WorkspaceTaskManifestEntry {
  task_id: string;
  title: string;
  description?: string;
  task_kind: TaskKind;
  task_mode: TaskMode;
  priority: TaskPriority;
  status: WorkspaceTaskStatus;
  eligibility: TaskEligibilityLabel;
  readiness: TaskReadinessLabel;
  blocker_reasons?: TaskBlockerReasons;
  recommended_action: TaskRecommendedAction;
  reason: string;
}

// ─── Verification Foundation v1 ───────────────────────────────────────────────

export type VerificationType =
  | "email_ownership"
  | "phone_ownership"
  | "government_id"
  | "student_status"
  | "military_status"
  | "business_org_control"
  | "domain_ownership"
  | "employment_status";

export type AssuranceLevel =
  | "self_asserted"
  | "provider_verified"
  | "document_verified";

export type DisclosurePolicy =
  | "user_approval_required"
  | "agent_visible"
  | "website_allowed"
  | "restricted";

export interface VerificationProviderSession {
  session_id: string;           // vps_...
  user_id: string;
  verification_type: VerificationType;
  provider_name: string;
  /** Opaque token from the provider. Optional until the provider confirms initiation. */
  provider_session_id?: string;
  status: "initiated" | "in_progress" | "completed" | "failed" | "expired" | "cancelled";
  created_at: string;
  expires_at: string;
}

/**
 * Typed, normalized claim values. These are stored internally and correspond to
 * Tier 2 claim details — they are never auto-disclosed as Tier 1 trust signals.
 * Tier 1 exposes only boolean availability flags (does the user have this claim type?).
 *
 * Fields like `country_code` and `id_type` for government_id are Tier 2 only.
 * Raw document scans, SSNs, DOB, legal name, address, biometrics, and document
 * numbers are never stored here — those remain with the provider.
 */
export type VerifiedClaimValue =
  | { kind: "email_ownership"; email_domain: string }
  | { kind: "phone_ownership"; phone_country_code: string }
  /** Tier 2 only — country_code and id_type are claim details, not trust signals. */
  | { kind: "government_id"; country_code: string; id_type: string }
  | { kind: "student_status"; institution_name: string; enrollment_status: string }
  | { kind: "military_status"; branch: string }
  | { kind: "business_control"; business_name: string }
  | { kind: "domain_ownership"; domain: string }
  | { kind: "employment_status"; employer_name?: string };

export interface VerifiedClaim {
  claim_id: string;    // vc_claim_...
  card_id: string;
  claim_type: VerificationType;
  claim_value: VerifiedClaimValue;
  assurance_level: AssuranceLevel;
  /**
   * Opaque reference token from the provider. Internal use only.
   * Must never be returned to agents, websites, or external API callers.
   */
  provider_reference_id?: string;
  verified_at: string;
  expires_at?: string;
}

export interface VerificationCard {
  card_id: string;            // vc_...
  schema_version: "1.0";
  issuer: "aegis";
  user_id: string;
  claims: VerifiedClaim[];
  disclosure_policy: DisclosurePolicy;
  issued_at: string;
  expires_at?: string;
  /**
   * Mutable field — intentionally excluded from the canonical hash so that
   * revocation does not invalidate the signed content of the card.
   */
  revocation_status: "active" | "revoked";
  limitations: {
    /** Always the literal false — raw documents are never revealed to agents. */
    raw_document_revealed_to_agent: false;
    /** Always the literal false — raw documents are never revealed to websites. */
    raw_document_revealed_to_website: false;
    /** Always true — only normalized provider-verified claims are stored. */
    provider_result_only: true;
    /** Always true — a VerificationCard is not a legal guarantee. */
    not_a_guarantee: true;
  };
  verification?: {
    card_hash: string;
    card_jws: string;
    jws_present: boolean;
    signing_alg: "EdDSA";
    signed_at: string;
    signing_key_id?: string;
  };
}

export interface DisclosureReceipt {
  receipt_id: string;         // vcdiscl_...
  receipt_type: "claim_disclosure";
  card_id: string;
  user_id: string;
  /** Specific claim types shared — never the full card or raw claim values. */
  claim_types_disclosed: VerificationType[];
  disclosure_target:
    | { kind: "agent"; agent_id: string; delegation_id: string }
    | { kind: "website"; domain: string };
  disclosure_policy_at_time: DisclosurePolicy;
  purpose?: string;
  approved_at: string;
  /** Linked UserApprovalReceipt when disclosure required explicit user approval. */
  uar_id?: string;
  limitations: {
    /** Always the literal false — raw documents are never included in disclosure receipts. */
    raw_document_revealed_to_target: false;
    /** Always the literal false — raw documents are never stored in receipts. */
    raw_document_in_receipt: false;
    /** Always the literal false — only specific claim types are disclosed, not the full card. */
    full_card_revealed: false;
  };
  verification?: {
    receipt_hash: string;
    receipt_jws: string;
    jws_present: boolean;
    signing_alg: "EdDSA";
    signed_at: string;
    signing_key_id?: string;
  };
}

/** Lightweight audit log for Tier 1 trust-signal disclosures in active delegation contexts. */
export interface TrustSignalDisclosureRecord {
  record_id: string;          // tsdr_...
  user_id: string;
  delegation_id: string;
  /** Claim types the user has — boolean availability only, no claim values. */
  verification_types_available: VerificationType[];
  disclosed_at: string;
  context: "active_delegation";
  limitations: {
    /** Always the literal false — raw documents are never revealed. */
    raw_document_revealed_to_agent: false;
    /** Always true — trust signals are not a legal guarantee. */
    not_a_guarantee: true;
  };
}
