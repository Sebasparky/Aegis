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

export interface AgentDelegation {
  id: string;
  user_id: string;
  user_aegis_id: string;
  agent_name: string;
  agent_platform?: string;
  channel: AgentDelegationChannel;
  default_collar_id: string;
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
  | "oauth_authorize";

export interface SpendingLimits {
  max_without_approval: number;
  max_with_approval: number;
  subscriptions_allowed: boolean;
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
  default_collar_id: string;
  status: PassStatus;
  expires_at: string;
  created_at: string;
}

export type AegisPassKind = "login_password";

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

export interface RuntimeCoverageSummary {
  sensitive_events: number;
  covered_events: number;
  uncovered_events: number;
  unknown_events: number;
  highest_severity: "info" | "warning" | "high" | "critical";
  sensitivities: RuntimeEventSensitivityKind[];
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
