import type {
  Collar,
  AegisPass,
  SensitiveGrant,
  ProtectedSession,
  ApprovalRequest,
  Receipt,
  ReputationSummary,
  RunnerTask,
  AegisIDTrustClaims,
  WebsiteAegisIDTrustClaims,
  AgentTrustPassport,
  AgentTask,
  AgentDelegation,
  AgentDelegationChannel,
  AegisRoute,
  RecordingPayload,
  RouteVerificationReport,
  ActionRequest,
  ActionDecisionResponse,
  Skill,
  InstalledSkill,
  RouteRunReceipt,
  RouteRun,
  SensitiveActionTimelineItem,
  AegisWorkspace,
  WorkspaceTask,
  WorkspaceArtifactKind,
  TaskKind,
  TaskMode,
  TaskPriority,
  TaskReadinessLabel,
  TaskBlockerReasons,
  UserApprovalReceipt,
  UserApprovalReceiptVerificationResult,
  WebsiteTrustProfile,
  WebsiteTrustProfileVerificationResult,
  WebsiteViolationReceipt,
  WebsiteViolationReceiptVerificationResult,
  AgentConnector,
  AgentConnectorPlatform,
  ConnectorPolicyMode,
  ConnectorStatus,
  VerificationType,
  RoutePreviewAsset,
  RouteReplayAsset,
  PublishedSkillVersion,
} from "@aegis/types";

export const BASE = "http://localhost:4000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? json.message ?? "API error");
  return json.data as T;
}

// User
export const getUser = () => request<{ id: string; email: string; display_name: string; aegis_id: string }>("/api/user/me");

// Collars
export const listCollars = () => request<Collar[]>("/api/collars");
export const getCollar = (id: string) => request<Collar>(`/api/collars/${id}`);
export const createCollar = (body: Partial<Collar>) =>
  request<Collar>("/api/collars", { method: "POST", body: JSON.stringify(body) });
export const updateCollar = (id: string, body: Partial<Collar>) =>
  request<Collar>(`/api/collars/${id}`, { method: "PATCH", body: JSON.stringify(body) });
export const revokeCollar = (id: string) =>
  request<{ id: string; status: string }>(`/api/collars/${id}/revoke`, { method: "POST" });

// Passes
export type PassWithToken = AegisPass & { token?: string };
export const listPasses = () => request<AegisPass[]>("/api/passes");
export const createPass = (body: { agent_name: string; purpose?: string; default_collar_id: string; expires_in_minutes?: number }) =>
  request<PassWithToken>("/api/passes", { method: "POST", body: JSON.stringify(body) });
export const revokePass = (id: string) =>
  request<{ id: string; status: string }>(`/api/passes/${id}/revoke`, { method: "POST" });

// Sessions
export const listSessions = () => request<ProtectedSession[]>("/api/sessions");

// Approvals
export const listApprovals = (status?: string) =>
  request<ApprovalRequest[]>(`/api/approvals${status ? `?status=${status}` : ""}`);
export const approveRequest = (id: string, note?: string) =>
  request<{ id: string; status: string; receipt_id: string; runner_task_id?: string }>(`/api/approvals/${id}/approve`, {
    method: "POST",
    body: JSON.stringify({ note }),
  });
export const denyRequest = (id: string, note?: string) =>
  request<{ id: string; status: string; receipt_id: string }>(`/api/approvals/${id}/deny`, {
    method: "POST",
    body: JSON.stringify({ note }),
  });

// Receipts
export const listReceipts = () => request<Receipt[]>("/api/receipts");

// Route Run Receipts
export const listRouteRunReceipts = () => request<RouteRunReceipt[]>("/api/route-run-receipts");
export const getRouteRunReceipt = (receiptId: string) => request<RouteRunReceipt>(`/api/route-run-receipts/${receiptId}`);

// User Approval Receipts
export const listUserApprovalReceipts = (params?: { decision?: string; source?: string }) => {
  const q = new URLSearchParams(Object.fromEntries(Object.entries(params ?? {}).filter(([, v]) => v))).toString();
  return request<UserApprovalReceipt[]>(`/api/user-approval-receipts${q ? `?${q}` : ""}`);
};
export const getUserApprovalReceipt = (id: string) =>
  request<UserApprovalReceipt>(`/api/user-approval-receipts/${id}`);
export const verifyUserApprovalReceipt = (id: string) =>
  request<UserApprovalReceiptVerificationResult>(`/api/user-approval-receipts/${id}/verify`);

// Website Trust Profiles
export const listWebsiteTrustProfiles = () =>
  request<WebsiteTrustProfile[]>("/api/website-trust-profiles");
export const verifyWebsiteTrustProfile = (id: string) =>
  request<WebsiteTrustProfileVerificationResult>(`/api/website-trust-profiles/${id}/verify`);

// Website Violation Receipts
export const listWebsiteViolationReceipts = (params?: {
  domain?: string;
  violation_type?: string;
  severity?: string;
  decision?: string;
}) => {
  const q = new URLSearchParams(Object.fromEntries(Object.entries(params ?? {}).filter(([, v]) => v))).toString();
  return request<{ receipts: WebsiteViolationReceipt[]; count: number }>(`/api/website-violation-receipts${q ? `?${q}` : ""}`);
};
export const getWebsiteViolationReceipt = (id: string) =>
  request<WebsiteViolationReceipt>(`/api/website-violation-receipts/${id}`);
export const verifyWebsiteViolationReceipt = (id: string) =>
  request<WebsiteViolationReceiptVerificationResult>(`/api/website-violation-receipts/${id}/verify`);

// Reputation
export const getReputationSummary = () => request<ReputationSummary>("/api/reputation/summary");

// Antigen ID
export const getAegisIDTrustClaims = () =>
  request<AegisIDTrustClaims>("/api/aegis-id/me/trust-claims");

// Agent (used by Demo page)
export const createAgentSession = (token: string, purpose?: string) =>
  request<{ session_id: string; status: string; expires_at: string }>("/api/agent/create-session", {
    method: "POST",
    body: JSON.stringify({ agent_pass_token: token, purpose, mode: "headless" }),
  });

export const agentNavigate = (token: string, sessionId: string, url: string) =>
  request<{ session_id: string; current_url: string; decision: string }>(
    `/api/agent/session/${sessionId}/navigate`,
    { method: "POST", body: JSON.stringify({ agent_pass_token: token, url }) }
  );

export const agentClick = (token: string, sessionId: string, target: { type: string; value: string }) =>
  request<{
    decision: string;
    executed: boolean;
    approval_request_id?: string;
    detected_action_type?: string;
    risk_level?: string;
    reason?: string;
  }>(
    `/api/agent/session/${sessionId}/click`,
    { method: "POST", body: JSON.stringify({ agent_pass_token: token, target }) }
  );

// Runners
export const listRunners = () => request<RunnerTask[]>("/api/runners");
export const getRunner = (id: string) => request<RunnerTask>(`/api/runners/${id}`);
export const executeRunner = (id: string) =>
  request<{ id: string; status: string; result?: string }>(`/api/runners/${id}/execute`, { method: "POST" });

// Website Antigen ID
export const getWebsiteTrustClaims = (domain: string) =>
  request<WebsiteAegisIDTrustClaims>(`/api/website-aegis-id/${encodeURIComponent(domain)}/trust-claims`);
export const listWebsiteTrustClaims = () =>
  request<WebsiteAegisIDTrustClaims[]>("/api/website-aegis-id");

// Counterparty Agent Verification
export const getAgentTrustPassport = (aegisId: string) =>
  request<AgentTrustPassport>(`/api/counterparty/agent/${encodeURIComponent(aegisId)}/trust-passport`);

// Agent Tasks
export const listTasks = () => request<AgentTask[]>("/api/tasks");
export const getTask = (taskId: string) => request<AgentTask>(`/api/tasks/${taskId}`);
export const createTask = (body: {
  title: string;
  description?: string;
  start_url: string;
  collar_id?: string;
  expires_in_minutes?: number;
}) =>
  request<{ task: AgentTask; launch_token: string }>("/api/tasks", {
    method: "POST",
    body: JSON.stringify(body),
  });
export const cancelTask = (taskId: string) =>
  request<AgentTask>(`/api/tasks/${taskId}/cancel`, { method: "POST" });
export const createTaskSession = (
  taskId: string,
  launchToken: string,
  mode?: "headless" | "visible"
) =>
  request<{
    task_id: string;
    session_id: string;
    start_url: string;
    collar_id: string;
    constraints: AgentTask["constraints"];
  }>(`/api/tasks/${taskId}/create-session`, {
    method: "POST",
    body: JSON.stringify({ launch_token: launchToken, mode }),
  });

// Agent Delegations
export const listDelegations = () => request<AgentDelegation[]>("/api/delegations");
export const createDelegation = (body: {
  agent_name: string;
  agent_platform?: string;
  channel?: AgentDelegationChannel;
  default_collar_id?: string;
  expires_in_minutes?: number;
}) =>
  request<{ delegation: AgentDelegation; delegation_token: string }>("/api/delegations", {
    method: "POST",
    body: JSON.stringify(body),
  });
export const revokeDelegation = (delegationId: string) =>
  request<{ id: string; status: string }>(`/api/delegations/${delegationId}/revoke`, {
    method: "POST",
    body: JSON.stringify({}),
  });

// Antigen Rails
export const listRoutes = (params?: { domain?: string; trust_tier?: string }) => {
  const qs = params
    ? "?" + new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v))).toString()
    : "";
  return request<AegisRoute[]>(`/api/routes${qs}`);
};
export const getRoute = (routeId: string) => request<AegisRoute>(`/api/routes/${routeId}`);
export const deleteRoute = (routeId: string) =>
  request<{ deleted: boolean }>(`/api/routes/${routeId}`, { method: "DELETE" });
export const recordRoute = (payload: RecordingPayload) =>
  request<{
    route_id: string;
    workflow_name: string;
    domain: string;
    trust_tier: string;
    risk_level: string;
    step_count: number;
    forbidden_action_count: number;
  }>("/api/routes/record", { method: "POST", body: JSON.stringify(payload) });
export const queryRoutes = (body: { domain: string; min_trust_tier?: string }) =>
  request<{ route: AegisRoute | null; matched: boolean; reason: string }>("/api/routes/query", {
    method: "POST",
    body: JSON.stringify(body),
  });
export const verifyRoute = (routeId: string) =>
  request<RouteVerificationReport>(`/api/routes/${routeId}/verify`, { method: "POST", body: JSON.stringify({}) });
export const triggerPreviewCapture = (routeId: string) =>
  request<{ captured: boolean; reason?: string; asset?: RoutePreviewAsset }>(`/api/routes/${routeId}/capture-preview`, { method: "POST", body: JSON.stringify({}) });
export const patchRoute = (routeId: string, body: { workflow_name?: string; workflow_description?: string }) =>
  request<AegisRoute>(`/api/routes/${routeId}`, { method: "PATCH", body: JSON.stringify(body) });
export const submitRouteForReview = (routeId: string) =>
  request<AegisRoute>(`/api/routes/${routeId}/submit-review`, { method: "POST", body: JSON.stringify({}) });
export const reviewRoute = (routeId: string, decision: "approved" | "rejected", review_note?: string) =>
  request<AegisRoute>(`/api/routes/${routeId}/review`, { method: "POST", body: JSON.stringify({ decision, review_note }) });
export const publishRoute = (routeId: string) =>
  request<{ route: AegisRoute; skill_id: string }>(`/api/routes/${routeId}/publish`, { method: "POST", body: JSON.stringify({}) });
export const getSkillByRoute = async (routeId: string): Promise<Skill | null> => {
  try {
    return await request<Skill>(`/api/routes/${routeId}/skill`);
  } catch {
    return null;
  }
};
export const unlistSkill = (skillId: string) =>
  request<Skill>(`/api/skills/${skillId}/unlist`, { method: "POST", body: JSON.stringify({}) });

// Skills Marketplace
export type SkillWithInstalled = Skill & { installed: boolean; created_by_you: boolean; preview_asset?: RoutePreviewAsset; replay_assets?: RouteReplayAsset[] };
export type SkillDetail = Skill & { installed: boolean; created_by_you: boolean; snapshot: PublishedSkillVersion | null };
export const getSkill = (skillId: string) => request<SkillDetail>(`/api/skills/${skillId}`);
export const listSkills = (params?: { domain?: string; installed?: boolean }) => {
  const entries: [string, string][] = [];
  if (params?.domain) entries.push(["domain", params.domain]);
  if (params?.installed !== undefined) entries.push(["installed", String(params.installed)]);
  const qs = entries.length ? "?" + new URLSearchParams(entries).toString() : "";
  return request<SkillWithInstalled[]>(`/api/skills${qs}`);
};
export const installSkill = (skillId: string) =>
  request<InstalledSkill>(`/api/skills/${skillId}/install`, { method: "POST", body: JSON.stringify({}) });
export const uninstallSkill = (skillId: string) =>
  request<{ uninstalled: boolean }>(`/api/skills/${skillId}/install`, { method: "DELETE" });
export const listInstalledSkills = () =>
  request<(InstalledSkill & { skill: Skill })[]>("/api/installed-skills");

// Route Runs
export type RouteRunWithSummary = RouteRun & {
  skill_summary: { skill_id: string; name: string; domain: string; risk_level?: string; execution_mode?: string; sensitivity_level?: string } | null;
  route_summary: { route_id: string; workflow_name: string; trust_tier: string; step_count: number; start_url?: string } | null;
};
export const listRouteRuns = (params?: { domain?: string; status?: string; route_id?: string }) => {
  const entries: [string, string][] = [];
  if (params?.domain) entries.push(["domain", params.domain]);
  if (params?.status) entries.push(["status", params.status]);
  if (params?.route_id) entries.push(["route_id", params.route_id]);
  const qs = entries.length ? "?" + new URLSearchParams(entries).toString() : "";
  return request<RouteRunWithSummary[]>(`/api/route-runs${qs}`);
};
export const approveRouteRun = (runId: string) =>
  request<RouteRun>(`/api/route-runs/${runId}/approve`, { method: "POST", body: JSON.stringify({}) });
export const rejectRouteRun = (runId: string, reason?: string) =>
  request<RouteRun>(`/api/route-runs/${runId}/reject`, {
    method: "POST",
    body: JSON.stringify({ reason: reason ?? "Rejected from approval queue." }),
  });

// Approval Context — safe manifest for pending_approval runs
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
}
export interface RunApprovalContext {
  run_id: string;
  manifest: ApprovalManifest;
  skill_name?: string;
  route_name?: string;
  agent_id?: string;
  execution_surface?: string;
}
export const getApprovalContext = (runId: string) =>
  request<RunApprovalContext>(`/api/route-runs/${runId}/approval-context`);
export const requestSpendingStepUp = (runId: string, requestedLimitUsd: number) =>
  request<RunApprovalContext>(`/api/route-runs/${runId}/spending-step-up`, {
    method: "POST",
    body: JSON.stringify({ requested_limit_usd: requestedLimitUsd, currency: "USD" }),
  });

// Vault Passes (dev-only credential custody — login_password bundles)
export interface VaultPassView {
  pass_id: string;
  user_id: string;
  label: string;
  kind: "login_password";
  domain: string;
  username?: string;
  created_at: string;
  updated_at: string;
  has_password: boolean;
}
export const listVaultPasses = () => request<VaultPassView[]>("/api/vault-passes");
export const createVaultPass = (body: { label: string; kind: "login_password"; domain: string; username: string; password: string }) =>
  request<VaultPassView>("/api/vault-passes", { method: "POST", body: JSON.stringify(body) });
export const deleteVaultPass = (passId: string) =>
  request<{ ok: boolean }>(`/api/vault-passes/${passId}`, { method: "DELETE" });

// ─── Payment Methods ──────────────────────────────────────────────────────────

export type PaymentMethodBrand = "visa" | "mastercard" | "amex" | "discover" | "unknown";
export type PaymentMethodStatus = "active" | "archived";

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

export const listPaymentMethods = () =>
  request<PaymentMethodView[]>("/api/payment-methods");

export const createPaymentMethod = (body: {
  label: string;
  cardholder_name: string;
  card_number: string;
  cvv: string;
  exp_month: number;
  exp_year: number;
  billing_zip?: string;
  billing_country?: string;
}) =>
  request<PaymentMethodView>("/api/payment-methods", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const updatePaymentMethod = (
  pmId: string,
  body: { label?: string; cardholder_name?: string; exp_month?: number; exp_year?: number; billing_zip?: string; billing_country?: string; is_default?: boolean }
) =>
  request<PaymentMethodView>(`/api/payment-methods/${pmId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });

export const archivePaymentMethod = (pmId: string) =>
  request<PaymentMethodView>(`/api/payment-methods/${pmId}/archive`, {
    method: "POST",
    body: JSON.stringify({}),
  });

export const deletePaymentMethod = (pmId: string) =>
  request<{ ok: boolean }>(`/api/payment-methods/${pmId}`, { method: "DELETE" });

// ─── Payment Card Fill Authorizations ─────────────────────────────────────────

export type PaymentCardField =
  | "card_number" | "cvv" | "expiry_month" | "expiry_year"
  | "expiry_combined" | "cardholder_name" | "billing_zip";

export interface PaymentCardFillAuthorizationView {
  authorization_id: string;
  domain: string;
  payment_method_label: string;
  last4: string;
  is_default: boolean;
  allowed_fields: PaymentCardField[];
  fields_filled: PaymentCardField[];
  status: string;
  raw_values_revealed_to_agent: false;
  purchase_not_authorized: true;
  created_at: string;
  expires_at: string;
  approved_at?: string;
  fulfilled_at?: string;
  // Note: payment_method_id intentionally absent — never returned by server
}

export const listPaymentCardFillAuthorizations = (status?: string) =>
  request<PaymentCardFillAuthorizationView[]>(
    `/api/internal/payment-card-fill-authorizations${status ? `?status=${status}` : ""}`,
  );

export const approvePaymentCardFillAuthorization = (id: string) =>
  request<{ authorization_id: string; status: string; raw_values_revealed_to_agent: false; purchase_not_authorized: true }>(
    `/api/internal/payment-card-fill-authorizations/${id}/approve`,
    { method: "POST", body: JSON.stringify({}) },
  );

export const denyPaymentCardFillAuthorization = (id: string) =>
  request<{ authorization_id: string; status: string }>(
    `/api/internal/payment-card-fill-authorizations/${id}/deny`,
    { method: "POST" },
  );

// ─── Purchase Confirmation Authorizations ──────────────────────────────────────

export interface PurchaseConfirmationAuthorizationView {
  purchase_confirmation_id: string;
  domain: string;
  page_url: string;
  merchant: string;
  amount?: number;
  currency: string;
  amount_unknown: boolean;
  item_summary: string;
  payment_method_label: string;
  payment_method_last4: string;
  button_text: string;
  card_fill_authorization_id?: string;
  status: string;
  risk_level: "high" | "critical";
  raw_values_revealed_to_agent: false;
  purchase_action_authorized: boolean;
  created_at: string;
  expires_at: string;
  approved_at?: string;
  fulfilled_at?: string;
  // payment_method_id intentionally absent — never returned by server
}

export const listPurchaseConfirmationAuthorizations = (status?: string) =>
  request<PurchaseConfirmationAuthorizationView[]>(
    `/api/internal/purchase-confirmation-authorizations${status ? `?status=${status}` : ""}`,
  );

export const approvePurchaseConfirmationAuthorization = (id: string) =>
  request<{ purchase_confirmation_id: string; status: string; purchase_action_authorized: boolean }>(
    `/api/internal/purchase-confirmation-authorizations/${id}/approve`,
    { method: "POST", body: JSON.stringify({}) },
  );

export const denyPurchaseConfirmationAuthorization = (id: string) =>
  request<{ purchase_confirmation_id: string; status: string }>(
    `/api/internal/purchase-confirmation-authorizations/${id}/deny`,
    { method: "POST" },
  );

export const importVaultPasses = (credentials: Array<{ label: string; kind: "login_password"; domain: string; username: string; password: string }>) =>
  request<{ imported: VaultPassView[]; failed: Array<{ index: number; reason: string }>; total_requested: number; total_imported: number }>(
    "/api/internal/vault-passes/import",
    { method: "POST", body: JSON.stringify({ credentials }) },
  );

// Route Pass Bindings
export interface RoutePassBinding {
  binding_id: string;
  user_id: string;
  route_id: string;
  pass_id: string;
  purpose: "login_password";
  created_at: string;
  updated_at: string;
}
export const listRoutePassBindings = (route_id?: string) => {
  const qs = route_id ? `?route_id=${encodeURIComponent(route_id)}` : "";
  return request<RoutePassBinding[]>(`/api/route-pass-bindings${qs}`);
};
export const setRoutePassBinding = (body: { route_id: string; pass_id: string; purpose?: "login_password" }) =>
  request<RoutePassBinding>("/api/route-pass-bindings", { method: "POST", body: JSON.stringify(body) });
export const clearRoutePassBinding = (route_id: string, purpose: "login_password" = "login_password") =>
  request<{ ok: boolean }>("/api/route-pass-bindings", { method: "DELETE", body: JSON.stringify({ route_id, purpose }) });

// Action API
export const requestAction = (body: ActionRequest) =>
  request<ActionDecisionResponse>("/api/action/request", {
    method: "POST",
    body: JSON.stringify(body),
  });

// Credential Sessions (field-level credential delegation — dev prototype only)
export interface CredentialSessionView {
  session_id: string;
  user_id: string;
  agent_id?: string;
  pass_id: string;
  pass_label?: string;
  pass_username?: string;
  domain: string;
  status: "pending_approval" | "active" | "completed" | "failed" | "expired";
  allowed_fields: Array<"username" | "password">;
  fields_filled: Array<{ field: string; filled_at: string; tab_url?: string }>;
  approved_at?: string;
  expires_at?: string;
  created_at: string;
  updated_at: string;
}
export const listCredentialSessions = (status?: CredentialSessionView["status"]) => {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return request<CredentialSessionView[]>(`/api/credential-sessions${qs}`);
};
export const approveCredentialSession = (sessionId: string) =>
  request<CredentialSessionView>(`/api/credential-sessions/${sessionId}/approve`, {
    method: "POST",
    body: JSON.stringify({}),
  });

// ─── Authenticated Session Boundary v1 ───────────────────────────────────────

export interface AuthenticatedSessionHandleView {
  session_id: string;
  user_id: string;
  delegation_id: string;
  domain: string;
  login_url: string;
  task_summary: string;
  status:
    | "pending_approval"
    | "login_in_progress"
    | "authenticated"
    | "manual_step_required"
    | "failed"
    | "expired";
  capabilities: string[];
  raw_cookies_revealed_to_agent: false;
  raw_storage_revealed_to_agent: false;
  raw_credentials_revealed_to_agent: false;
  manual_step_reason?: string;
  created_at: string;
  expires_at: string;
}

export const listAuthenticatedSessions = (status?: string) => {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return request<AuthenticatedSessionHandleView[]>(`/api/authenticated-sessions${qs}`);
};

export const approveAuthenticatedSession = (sessionId: string) =>
  request<AuthenticatedSessionHandleView>(`/api/authenticated-sessions/${sessionId}/approve`, {
    method: "POST",
    body: JSON.stringify({}),
  });

export const rejectAuthenticatedSession = (sessionId: string) =>
  request<AuthenticatedSessionHandleView>(`/api/authenticated-sessions/${sessionId}/reject`, {
    method: "POST",
    body: JSON.stringify({}),
  });

// ─── Agent-Browser Secret Injection v1 ───────────────────────────────────────

export interface SecretFieldInjectionView {
  injection_request_id: string;
  domain: string;
  field_kind: "username" | "password";
  page_url: string;
  element_hint?: {
    label?: string;
    placeholder?: string;
    input_type?: string;
    selector_hint?: string;
  };
  reason: string;
  status: string;
  raw_value_revealed_to_agent: false;
  created_at: string;
  expires_at: string;
  approved_at?: string;
  filled_at?: string;
  error?: string;
}

export const listSecretFieldInjections = (status?: string) => {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return request<SecretFieldInjectionView[]>(`/api/internal/injections${qs}`);
};

export const approveSecretFieldInjection = (id: string) =>
  request<{ injection_request_id: string; status: string }>(
    `/api/internal/injections/${id}/approve`,
    { method: "POST", body: JSON.stringify({}) },
  );

export const denySecretFieldInjection = (id: string) =>
  request<{ injection_request_id: string; status: string }>(
    `/api/internal/injections/${id}/deny`,
    { method: "POST", body: JSON.stringify({}) },
  );

// ─── Credential-use authorization (one approval per login attempt) ────────────

export interface CredentialUseAuthorizationView {
  authorization_id: string;
  domain: string;
  pass_label: string;
  pass_username?: string;
  allowed_field_kinds: Array<"username" | "password">;
  max_uses_per_field: { username?: number; password?: number };
  use_counts: { username: number; password: number };
  purpose: "login";
  status: string;
  raw_values_revealed_to_agent: false;
  created_at: string;
  expires_at: string;
  approved_at?: string;
  fulfilled_at?: string;
  last_used_at?: string;
  used_field_kinds: Array<"username" | "password">;
}

export const listCredentialUseAuthorizations = (status?: string) => {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return request<CredentialUseAuthorizationView[]>(`/api/internal/credential-authorizations${qs}`);
};

export const approveCredentialUseAuthorization = (id: string) =>
  request<{ authorization_id: string; status: string }>(
    `/api/internal/credential-authorizations/${id}/approve`,
    { method: "POST", body: JSON.stringify({}) },
  );

export const denyCredentialUseAuthorization = (id: string) =>
  request<{ authorization_id: string; status: string }>(
    `/api/internal/credential-authorizations/${id}/deny`,
    { method: "POST", body: JSON.stringify({}) },
  );

// ─── Challenge Relay v1 ───────────────────────────────────────────────────────

export interface SecurityChallengeView {
  challenge_id: string;
  domain: string;
  page_url: string;
  challenge_type: string;
  status: string;
  masked_destination?: string;
  element_hint?: {
    label?: string;
    placeholder?: string;
    input_type?: string;
    selector_hint?: string;
  };
  instructions: string;
  raw_code_revealed_to_agent: false;
  created_at: string;
  expires_at: string;
  submitted_at?: string;
  injected_at?: string;
  completed_at?: string;
  error?: string;
}

export const listSecurityChallenges = (status?: string) => {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return request<SecurityChallengeView[]>(`/api/internal/security-challenges${qs}`);
};

export const submitSecurityChallengeCode = (challengeId: string, code: string) =>
  request<SecurityChallengeView>(
    `/api/internal/security-challenges/${challengeId}/submit-code`,
    { method: "POST", body: JSON.stringify({ code }) },
  );

export const completeSecurityChallenge = (challengeId: string) =>
  request<SecurityChallengeView>(
    `/api/internal/security-challenges/${challengeId}/complete`,
    { method: "POST", body: JSON.stringify({}) },
  );

export const cancelSecurityChallenge = (challengeId: string) =>
  request<SecurityChallengeView>(
    `/api/internal/security-challenges/${challengeId}/cancel`,
    { method: "POST", body: JSON.stringify({}) },
  );

// ─── Human Presence Relay v1 ──────────────────────────────────────────────────

export type HumanVerificationChallengeType =
  | "press_and_hold"
  | "checkbox_human"
  | "image_captcha"
  | "text_captcha"
  | "puzzle_captcha"
  | "unknown_human_verification";

export type HumanVerificationStatus =
  | "pending_user"
  | "in_progress"
  | "completed"
  | "expired"
  | "failed"
  | "cancelled";

export interface HumanVerificationRequestView {
  request_id: string;
  delegation_id: string;
  agent_name?: string;
  browser_session_id: string;
  domain: string;
  page_url: string;
  challenge_type: HumanVerificationChallengeType;
  challenge_label: string;
  relay_capable: boolean;
  /**
   * Page-level full-page denial wall whose control is inside a cross-origin
   * iframe Aegis can't relay into — render the manual-completion + recheck
   * branch (never the live press-and-hold button).
   */
  page_level?: boolean;
  status: HumanVerificationStatus;
  surface_title?: string;
  instructions: string;
  user_presence_required: true;
  purchase_authorized: false;
  hold_attempt_count: number;
  completion_mode?: "relayed_live_presence" | "manual_user_completion";
  created_at: string;
  expires_at: string;
  started_at?: string;
  completed_at?: string;
  resumed_at?: string;
  error?: string;
}

export type HumanVerificationHoldView = HumanVerificationRequestView & {
  hold_state?: "holding" | "released" | "released_fail_closed" | "challenge_gone";
  held_ms?: number;
  challenge_present?: boolean;
  confirm_state?: "cleared" | "still_present" | "challenge_gone";
};

export const listHumanVerificationRequests = (status?: string) => {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return request<HumanVerificationRequestView[]>(`/api/internal/human-verification-requests${qs}`);
};

export const getHumanVerificationRequest = (id: string) =>
  request<HumanVerificationRequestView>(`/api/internal/human-verification-requests/${id}`);

export const startHumanVerificationHold = (id: string) =>
  request<HumanVerificationHoldView>(
    `/api/internal/human-verification-requests/${id}/hold-start`,
    { method: "POST", body: JSON.stringify({}) },
  );

export const sendHumanVerificationHeartbeat = (id: string) =>
  request<{ request_id: string; hold_state: "holding" | "released_fail_closed" }>(
    `/api/internal/human-verification-requests/${id}/heartbeat`,
    { method: "POST", body: JSON.stringify({}) },
  );

export const endHumanVerificationHold = (id: string) =>
  request<HumanVerificationHoldView>(
    `/api/internal/human-verification-requests/${id}/hold-end`,
    { method: "POST", body: JSON.stringify({}) },
  );

export const confirmHumanPresence = (id: string) =>
  request<HumanVerificationHoldView>(
    `/api/internal/human-verification-requests/${id}/confirm`,
    { method: "POST", body: JSON.stringify({}) },
  );

export const recheckHumanVerification = (id: string) =>
  request<HumanVerificationHoldView>(
    `/api/internal/human-verification-requests/${id}/recheck`,
    { method: "POST", body: JSON.stringify({}) },
  );

export const cancelHumanVerificationRequest = (id: string) =>
  request<HumanVerificationRequestView>(
    `/api/internal/human-verification-requests/${id}/cancel`,
    { method: "POST", body: JSON.stringify({}) },
  );

// ─── Profile Memory Requests v1 ──────────────────────────────────────────────

export interface ProfileMemoryRequestView {
  request_id: string;
  domain: string;
  page_url: string;
  missing_fields: string[];
  reason: string;
  status: string;
  raw_profile_value_revealed_to_agent: false;
  created_at: string;
  expires_at: string;
  completed_at?: string;
}

export const listProfileMemoryRequests = (status?: string) => {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return request<ProfileMemoryRequestView[]>(`/api/internal/profile-memory-requests${qs}`);
};

export const submitProfileMemoryRequest = (
  requestId: string,
  values: Record<string, string>,
  save_for_future: boolean,
) =>
  request<{ request_id: string; status: string; fields_stored: string[] }>(
    `/api/internal/profile-memory-requests/${requestId}/submit`,
    { method: "POST", body: JSON.stringify({ values, save_for_future }) },
  );

export const cancelProfileMemoryRequest = (requestId: string) =>
  request<{ request_id: string; status: string }>(
    `/api/internal/profile-memory-requests/${requestId}/cancel`,
    { method: "POST", body: JSON.stringify({}) },
  );

// ─── Connected Email Challenge Resolver v1 ────────────────────────────────────

export interface EmailResolverStatusView {
  connected: boolean;
  method: "env_var" | "none";
}

export interface ChallengeEmailResolutionView {
  resolution_id: string;
  challenge_id: string;
  provider: string;
  domain: string;
  status: string;
  raw_code_revealed_to_agent: false;
  email_body_revealed_to_agent: false;
  search_window_started_at: string;
  searched_at?: string;
  found_at?: string;
  injected_at?: string;
  sender_domain?: string;
  received_at?: string;
  extraction_source?: "subject_snippet" | "body_text";
  error?: string;
  email_search_error_code?: "GMAIL_RECONNECT_REQUIRED" | "GMAIL_SEARCH_UNAVAILABLE";
  manual_entry_available?: true;
  created_at: string;
  updated_at: string;
}

export const getEmailResolverStatus = () =>
  request<EmailResolverStatusView>("/api/internal/email-resolver/status");

export const getChallengeEmailResolutions = (challengeId: string) =>
  request<ChallengeEmailResolutionView[]>(
    `/api/internal/challenge-email-resolutions?challenge_id=${encodeURIComponent(challengeId)}`,
  );

export const startChallengeEmailResolution = (challengeId: string) =>
  request<ChallengeEmailResolutionView>(
    "/api/internal/challenge-email-resolutions/start",
    { method: "POST", body: JSON.stringify({ challenge_id: challengeId }) },
  );

export const cancelChallengeEmailResolution = (resolutionId: string) =>
  request<ChallengeEmailResolutionView>(
    `/api/internal/challenge-email-resolutions/${resolutionId}/cancel`,
    { method: "POST", body: JSON.stringify({}) },
  );

// ─── Workspace Control Surface ───────────────────────────────────────────────

export type WorkspaceTaskWithReadiness = WorkspaceTask & {
  readiness: TaskReadinessLabel;
  blocker_reasons?: TaskBlockerReasons;
};

export type WorkspaceArtifactMeta = {
  artifact_id: string;
  workspace_id: string;
  name: string;
  kind: WorkspaceArtifactKind;
  task_id?: string;
  created_by_delegation_id?: string;
  size_bytes: number;
  mime_type?: string; // present for kind="file"
  created_at: string;
};

export type WorkspaceArtifactFull = WorkspaceArtifactMeta & { content?: string };

export type WorkspaceWithCounts = AegisWorkspace & {
  task_counts: { open: number; in_progress: number; completed: number; cancelled: number };
  artifact_count: number;
};

export const listWorkspaces = () => request<WorkspaceWithCounts[]>("/api/workspaces");
export const getWorkspace = (id: string) => request<WorkspaceWithCounts>(`/api/workspaces/${id}`);
export const listWorkspaceTasks = (workspaceId: string) =>
  request<WorkspaceTaskWithReadiness[]>(`/api/workspaces/${workspaceId}/tasks`);
export const createWorkspaceTask = (
  workspaceId: string,
  body: {
    title: string;
    description?: string;
    task_kind?: TaskKind;
    task_mode?: TaskMode;
    priority?: TaskPriority;
    assignment_type?: "open" | "delegation" | "collar";
    assigned_delegation_id?: string;
    required_collar_id?: string;
    depends_on_task_ids?: string[];
    required_artifact_names?: string[];
  },
) => request<WorkspaceTask>(`/api/workspaces/${workspaceId}/tasks`, { method: "POST", body: JSON.stringify(body) });
export const resetWorkspaceTask = (workspaceId: string, taskId: string) =>
  request<WorkspaceTask>(`/api/workspaces/${workspaceId}/tasks/${taskId}/reset`, { method: "PATCH" });
export const createWorkspace = (body: { name: string; description?: string; collar_id: string; participant_delegation_ids?: string[] }) =>
  request<AegisWorkspace>("/api/workspaces", { method: "POST", body: JSON.stringify(body) });
export const listWorkspaceArtifacts = (workspaceId: string) =>
  request<WorkspaceArtifactMeta[]>(`/api/workspaces/${workspaceId}/artifacts`);
export const getWorkspaceArtifact = (workspaceId: string, artifactId: string) =>
  request<WorkspaceArtifactFull>(`/api/workspaces/${workspaceId}/artifacts/${artifactId}`);
export const createWorkspaceArtifact = (
  workspaceId: string,
  body: { name: string; kind: WorkspaceArtifactKind; content: string; task_id?: string },
) =>
  request<WorkspaceArtifactMeta>(`/api/workspaces/${workspaceId}/artifacts`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export async function uploadWorkspaceArtifact(
  workspaceId: string,
  file: File,
  name: string,
  task_id?: string,
): Promise<WorkspaceArtifactMeta> {
  const form = new FormData();
  form.append("file", file);
  form.append("name", name);
  if (task_id) form.append("task_id", task_id);
  // No Content-Type header — browser sets multipart/form-data with boundary automatically
  const res = await fetch(`${BASE}/api/workspaces/${workspaceId}/artifacts/upload`, {
    method: "POST",
    body: form,
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? "Upload failed");
  return json.data as WorkspaceArtifactMeta;
}

export function getArtifactDownloadUrl(workspaceId: string, artifactId: string): string {
  return `${BASE}/api/workspaces/${workspaceId}/artifacts/${artifactId}/download`;
}

// ─── Sensitive Action Receipt Timeline v1 ────────────────────────────────────

export async function listSensitiveReceiptTimeline(params?: {
  browser_session_id?: string;
  authorization_id?: string;
  challenge_id?: string;
  since?: "today" | "24h" | "7d" | "all";
  event_group?: "all" | "browser" | "credential" | "challenge" | "email" | "payment" | "human_presence";
  limit?: number;
}): Promise<{ items: SensitiveActionTimelineItem[] }> {
  const url = new URL(`${BASE}/api/internal/sensitive-receipts/recent`);
  if (params?.browser_session_id) url.searchParams.set("browser_session_id", params.browser_session_id);
  if (params?.authorization_id) url.searchParams.set("authorization_id", params.authorization_id);
  if (params?.challenge_id) url.searchParams.set("challenge_id", params.challenge_id);
  if (params?.since) url.searchParams.set("since", params.since);
  if (params?.event_group) url.searchParams.set("event_group", params.event_group);
  if (params?.limit) url.searchParams.set("limit", String(params.limit));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error("Failed to fetch sensitive receipt timeline");
  return res.json();
}

// ─── Sensitive Grants v1 ──────────────────────────────────────────────────────

export interface SensitiveGrantVerifyResult {
  grant_id: string;
  linked_uar_id: string;
  uar_valid: boolean;
  uar_hash_valid?: boolean;
  scope_consistent: boolean;
  grant_status: string;
  uar_error?: string;
}

export const listSensitiveGrants = (filters?: {
  grant_type?: string;
  status?: string;
  domain?: string;
}) => {
  const q = new URLSearchParams(
    Object.fromEntries(Object.entries(filters ?? {}).filter(([, v]) => v))
  ).toString();
  return request<SensitiveGrant[]>(`/api/sensitive-grants${q ? `?${q}` : ""}`);
};

export const getSensitiveGrant = (grantId: string) =>
  request<SensitiveGrant>(`/api/sensitive-grants/${grantId}`);

export const verifySensitiveGrant = (grantId: string) =>
  request<SensitiveGrantVerifyResult>(`/api/sensitive-grants/${grantId}/verify`);

export const revokeSensitiveGrant = (grantId: string, reason?: string) =>
  request<{ grant_id: string; status: string }>(
    `/api/sensitive-grants/${grantId}/revoke`,
    { method: "POST", body: JSON.stringify({ reason }) },
  );

// ─── Agent Connectors ─────────────────────────────────────────────────────────

export const createAgentConnector = (body: {
  display_name: string;
  platform: AgentConnectorPlatform;
  policy_mode: ConnectorPolicyMode;
  collar_id?: string;
}) =>
  request<{ connector: AgentConnector; delegation: AgentDelegation; setup: unknown }>(
    "/api/agent-connectors",
    { method: "POST", body: JSON.stringify(body) },
  );

export const listAgentConnectors = () =>
  request<AgentConnector[]>("/api/agent-connectors");

export const getAgentConnectorStatus = (id: string) =>
  request<{
    connector_id: string;
    display_name: string;
    status: ConnectorStatus;
    last_seen_at?: string;
    delegation_id: string;
    delegation_status: string;
  }>(`/api/agent-connectors/${id}/status`);

export const revokeAgentConnector = (id: string) =>
  request<{ connector_id: string; status: "revoked"; delegation_revoked: boolean }>(
    `/api/agent-connectors/${id}/revoke`,
    { method: "POST", body: JSON.stringify({}) },
  );

// ─── Login Failure Diagnostics v1 ────────────────────────────────────────────

export type LoginOutcomeCode =
  | "login_success"
  | "invalid_credentials"
  | "manual_challenge_required"
  | "captcha_required"
  | "rate_limited"
  | "unknown_failure";

export interface LoginDiagnosticView {
  diagnostic_id: string;
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

export const listLoginDiagnostics = () =>
  request<LoginDiagnosticView[]>("/api/internal/login-diagnostics/recent");

// ─── Verification Cards v1 ───────────────────────────────────────────────────
// Safe view returned by list and revoke (toVerificationCardSummary in backend)
export interface VerificationCardSummary {
  card_id: string;
  claim_types: VerificationType[];
  assurance_level?: string;
  disclosure_policy: string;
  issued_at: string;
  expires_at?: string;
  revocation_status: "active" | "revoked";
  jws_present: boolean;
}

// Detailed view returned by get and complete (toVerificationCardDetail in backend)
// provider_reference_id intentionally omitted by the backend safe view
export interface VerificationCardDetail {
  card_id: string;
  schema_version: string;
  issuer: string;
  claims: Array<{
    claim_id: string;
    claim_type: VerificationType;
    claim_value: Record<string, string>;
    assurance_level: string;
    verified_at: string;
    expires_at?: string;
  }>;
  disclosure_policy: string;
  issued_at: string;
  expires_at?: string;
  revocation_status: "active" | "revoked";
  limitations: {
    raw_document_revealed_to_agent: false;
    raw_document_revealed_to_website: false;
    provider_result_only: true;
    not_a_guarantee: true;
  };
  jws_present: boolean;
}

// Session response (fields directly, not nested; provider_session_id omitted by backend)
export interface VerificationSessionView {
  session_id: string;
  verification_type: VerificationType;
  provider_name: string;
  status: string;
  created_at?: string;
  expires_at: string;
  redirect_url?: string;
  requires_code_step?: boolean;
  delivery_channel?: "email";
  delivery_mode?: "email" | "dev_console";
}

// External provider handoff types
export interface ExternalVerificationProviderDescriptor {
  provider_name: string;
  display_name: string;
  supported_types: VerificationType[];
  provider_category: "affiliation" | "identity";
  real_provider_family: string;
  handoff_mode: string;
  privacy_summary: string[];
  agent_disclosure_summary: string[];
}

export interface ExternalVerificationHandoffView {
  session_id: string;
  verification_type: VerificationType;
  provider_name: string;
  provider_display_name: string;
  status: string;
  title: string;
  description: string;
  privacy_guarantees: string[];
  agent_can_prove: string[];
  expires_at: string;
  handoff_mode: "mock_modal" | "redirect" | "embedded";
  handoff_url?: string;
  raw_provider_payload_revealed_to_agent: false;
  raw_document_revealed_to_agent: false;
}

export const listVerificationTypes = () =>
  request<{
    providers: Array<{ name: string; supported_types: VerificationType[] }>;
    external_providers: ExternalVerificationProviderDescriptor[];
  }>("/api/verifications/types");

export const createExternalVerificationSession = (body: {
  verification_type: VerificationType;
  provider_name: string;
}) =>
  request<{ session_id: string; status: string; handoff: ExternalVerificationHandoffView }>(
    "/api/verifications/external-sessions",
    { method: "POST", body: JSON.stringify(body) },
  );

export const getExternalVerificationSession = (sessionId: string) =>
  request<{ handoff: ExternalVerificationHandoffView }>(
    `/api/verifications/external-sessions/${sessionId}`,
  );

export const mockCompleteExternalSession = (sessionId: string) =>
  request<{ card: VerificationCardSummary; session_id: string }>(
    `/api/verifications/external-sessions/${sessionId}/mock-complete`,
    { method: "POST", body: JSON.stringify({}) },
  );

export const syncExternalVerificationSession = (sessionId: string) =>
  request<{
    status: "card_issued" | "pending" | "provider_pending" | "requires_input" | "failed";
    card?: VerificationCardSummary;
    session_id?: string;
    failure_reason?: string;
  }>(
    `/api/verifications/external-sessions/${sessionId}/sync`,
    { method: "POST", body: JSON.stringify({}) },
  );

export const createVerificationSession = (body: {
  verification_type: VerificationType;
  provider_name?: string;
  mock_input?: unknown;
}) =>
  request<VerificationSessionView>("/api/verifications/sessions", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const getVerificationSession = (sessionId: string) =>
  request<VerificationSessionView>(`/api/verifications/sessions/${sessionId}`);

export const completeVerificationSession = (sessionId: string, body?: { mock_input?: unknown }) =>
  request<{ card: VerificationCardDetail }>(
    `/api/verifications/sessions/${sessionId}/complete`,
    { method: "POST", body: JSON.stringify(body ?? {}) },
  );

export const listVerificationCards = () =>
  request<{ cards: VerificationCardSummary[] }>("/api/verifications/cards");

export const getVerificationCard = (cardId: string) =>
  request<{ card: VerificationCardDetail }>(`/api/verifications/cards/${cardId}`);

export const verifyVerificationCard = (cardId: string) =>
  request<{
    hash_valid: boolean;
    signature_valid: boolean;
    expired: boolean;
    revoked: boolean;
    jws_present: boolean;
    error?: string;
  }>(`/api/verifications/cards/${cardId}/verify`);

export const revokeVerificationCard = (cardId: string) =>
  request<{ card: VerificationCardSummary }>(
    `/api/verifications/cards/${cardId}/revoke`,
    { method: "POST", body: JSON.stringify({}) },
  );

export const createEmailVerificationSession = (body: {
  verification_type: "email_ownership";
  provider_name: "email_otp" | "local_email";
  email: string;
}) =>
  request<VerificationSessionView>("/api/verifications/sessions", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const submitVerificationCode = (sessionId: string, code: string) =>
  request<{ card: VerificationCardDetail }>(
    `/api/verifications/sessions/${sessionId}/submit-code`,
    { method: "POST", body: JSON.stringify({ code }) },
  );

// ─── Account Access Resolution v1 ─────────────────────────────────────────────

export interface AccountCreationRequestView {
  request_id: string;
  domain: string;
  signup_url: string;
  reason: string;
  wall_type: "login" | "signup" | "unknown";
  status: string;
  raw_password_revealed_to_agent: false;
  otp_revealed_to_agent: false;
  email_strategy?: "primary_email" | "custom_email";
  password_strategy?: "aegis_generated" | "user_provided";
  has_default_account_email?: boolean;
  created_at: string;
  expires_at: string;
  approved_at?: string;
  completed_at?: string;
  denied_at?: string;
  error?: string;
}

export interface AccountCreationApproveBody {
  email_strategy: string;
  password_strategy: string;
  email?: string;
  save_as_default_account_email?: boolean;
}

export const listAccountCreationRequests = (status?: string) => {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return request<AccountCreationRequestView[]>(`/api/internal/account-creation-requests${qs}`);
};

// Uses raw fetch so the error code is preserved for inline recovery in the approval card.
export const approveAccountCreationRequest = async (
  requestId: string,
  body: AccountCreationApproveBody,
): Promise<AccountCreationRequestView> => {
  const res = await fetch(`${BASE}/api/internal/account-creation-requests/${requestId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) {
    const err = new Error(json.error?.message ?? "Approval failed.") as Error & { code?: string };
    err.code = json.error?.code;
    throw err;
  }
  return json.data as AccountCreationRequestView;
};

export const denyAccountCreationRequest = (requestId: string) =>
  request<AccountCreationRequestView>(
    `/api/internal/account-creation-requests/${requestId}/deny`,
    { method: "POST", body: JSON.stringify({}) },
  );

export interface AccountCreationStepRequestView {
  step_request_id: string;
  account_creation_request_id: string;
  domain: string;
  page_url: string;
  requested_fields: string[];
  status: string;
  created_at: string;
  expires_at: string;
  resolved_at?: string;
  error?: string;
  profile_fill_request_id?: string;
  pass_id?: string;
  email_verification_request_id?: string;
  raw_email_revealed_to_agent: false;
  raw_username_revealed_to_agent: false;
  raw_password_revealed_to_agent: false;
  otp_revealed_to_agent: false;
}

export const listAccountCreationStepRequests = (accountCreationRequestId?: string) => {
  const qs = accountCreationRequestId
    ? `?account_creation_request_id=${encodeURIComponent(accountCreationRequestId)}`
    : "";
  return request<AccountCreationStepRequestView[]>(`/api/internal/account-creation-step-requests${qs}`);
};

export const submitStepEmail = (
  stepRequestId: string,
  body: { email: string; save_as_default?: boolean },
) =>
  request<AccountCreationStepRequestView>(
    `/api/internal/account-creation-step-requests/${stepRequestId}/submit-email`,
    { method: "POST", body: JSON.stringify(body) },
  );

// ─── Visual Gesture Capsules (internal user-presence loop) ────────────────────
//
// Thin client for the internal VGC endpoints that drive the opaque-HV-wall
// user-presence loop. The UI never holds a cdp_url — the server derives the
// browser CDP context from the capsule (M2B), so all request bodies here are
// cdp_url-free. Screenshot bytes flow ONLY through getVisualGestureCapsuleScreenshot
// and are used solely as an <img> src; never logged, never sent to /gesture or
// /recheck. No cdp_url / target_id / browser_session_id is ever sent or surfaced.

export type VisualGestureKind = "tap" | "press_hold";

export type VisualGestureCapsuleStatus =
  | "awaiting_user_gesture"
  | "relaying"
  | "checking"
  | "cleared"
  | "rejected_retryable"
  | "manual_fallback"
  | "expired"
  | "failed"
  | "cancelled";

/** Safe capsule view — mirrors the backend SafeVisualGestureCapsuleView. No
 *  cdp_url / browser_session_id / target_id fields exist on this shape. */
export interface VisualGestureCapsuleView {
  capsule_id: string;
  status: VisualGestureCapsuleStatus;
  supported_gestures: VisualGestureKind[];
  attempt_count: number;
  max_attempts: number;
  /** Recommended hold duration (ms) for the current attempt — guided 5s/10s/15s ladder. */
  recommended_hold_ms: number;
  domain: string;
  page_url?: string;
  expires_at: string;
  screenshot_available: boolean;
  screenshot_captured_at?: string;
  screenshot_expires_at?: string;
  user_presence_required: true;
  raw_gesture_revealed_to_agent: false;
  screenshot_revealed_to_agent: false;
  purchase_authorized: false;
}

export interface VisualGestureCapsuleScreenshot {
  mime_type: "image/png";
  png_base64: string;
  captured_at: string;
  expires_at: string;
}

export interface VisualGestureGesturePayload {
  kind: VisualGestureKind;
  fx: number;
  fy: number;
  duration_ms?: number;
}

export interface VisualGestureGestureResult {
  gesture_relayed: true;
  status: VisualGestureCapsuleStatus;
  data: VisualGestureCapsuleView;
}

export type VisualGestureRecheckOutcome =
  | "cleared"
  | "still_present"
  | "inconclusive"
  | "unknown";

export interface VisualGestureRecheckResult {
  recheck: VisualGestureRecheckOutcome;
  status: VisualGestureCapsuleStatus;
  attempt_count: number;
  data: VisualGestureCapsuleView;
}

export interface VisualGestureRecaptureResult {
  screenshot_available: boolean;
  screenshot_captured_at?: string;
  screenshot_expires_at?: string;
}

export interface VisualGestureCancelResult {
  cancelled: boolean;
  data: VisualGestureCapsuleView;
}

/** Raw VGC request: these endpoints return trust-relevant fields at the TOP level
 *  (not under `data`), so we read the parsed envelope directly. Throws a clean
 *  Error carrying the backend error.code so the UI can branch (e.g. MANUAL_FALLBACK,
 *  SCREENSHOT_FRAME_UNAVAILABLE, BROWSER_SESSION_UNAVAILABLE). */
async function vgcRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  const json = await res.json();
  if (!json.ok) {
    const err = new Error(json.error?.message ?? "Visual gesture capsule request failed");
    (err as Error & { code?: string }).code = json.error?.code;
    throw err;
  }
  return json as T;
}

export const listVisualGestureCapsules = () =>
  vgcRequest<{ ok: true; data: VisualGestureCapsuleView[]; disabled?: boolean }>(
    `/api/internal/visual-gesture-capsules`,
  );

/** Safe HV handoff status — mirrors the backend HumanVerificationHandoffUpdate.
 *  No cdp_url / browser_session is rendered; correlation is by `capsule_id`. The
 *  phase drives the live status copy ("keep holding" → "all done"). */
export type HvHandoffPhase =
  | "detected"
  | "presenting_to_user"
  | "user_interaction_required"
  | "holding"
  | "still_active"
  | "release_ready"
  | "looks_complete_checking"
  | "completed"
  | "resumed"
  | "expired"
  | "cancelled";

export interface HvHandoffUpdate {
  type: "human_verification_handoff_update";
  browser_session_id: string;
  capsule_id?: string;
  human_verification_request_id?: string;
  domain?: string;
  source: "visual_judgment" | "visual_gesture_capsule";
  phase: HvHandoffPhase;
  requires_user_attention: boolean;
  agent_should_wait: boolean;
  model_label?: string;
  model_confidence?: number;
  visual_policy_decision?: string;
  trigger_basis?: string;
  presence_source?: "model" | "dom_probe" | "none";
  release_authority: "conservative_probe";
  raw_surface_revealed_to_agent: false;
  created_at: string;
  expires_at: string;
}

export const listHvHandoffUpdates = () =>
  vgcRequest<{ ok: true; data: HvHandoffUpdate[] }>(
    `/api/internal/human-verification-handoff`,
  );

export const getVisualGestureCapsuleScreenshot = (capsuleId: string) =>
  vgcRequest<{ ok: true } & VisualGestureCapsuleScreenshot>(
    `/api/internal/visual-gesture-capsules/${capsuleId}/screenshot`,
  );

// cdp_url-free body: only the normalized gesture leaves the client.
export const submitVisualGestureCapsuleGesture = (
  capsuleId: string,
  gesture: VisualGestureGesturePayload,
) =>
  vgcRequest<{ ok: true } & VisualGestureGestureResult>(
    `/api/internal/visual-gesture-capsules/${capsuleId}/gesture`,
    { method: "POST", body: JSON.stringify({ gesture }) },
  );

export const recheckVisualGestureCapsule = (capsuleId: string) =>
  vgcRequest<{ ok: true } & VisualGestureRecheckResult>(
    `/api/internal/visual-gesture-capsules/${capsuleId}/recheck`,
    { method: "POST", body: JSON.stringify({}) },
  );

export const recaptureVisualGestureCapsule = (capsuleId: string) =>
  vgcRequest<{ ok: true } & VisualGestureRecaptureResult>(
    `/api/internal/visual-gesture-capsules/${capsuleId}/recapture`,
    { method: "POST", body: JSON.stringify({}) },
  );

export const cancelVisualGestureCapsule = (capsuleId: string) =>
  vgcRequest<{ ok: true } & VisualGestureCancelResult>(
    `/api/internal/visual-gesture-capsules/${capsuleId}/cancel`,
    { method: "POST", body: JSON.stringify({}) },
  );

// ─── Dominant surface reviews (NON-HV uncertain blocked surfaces) ─────────────
// Mirrors the backend SafeDominantSurfaceReviewView. This is NOT human
// verification: there is no gesture, no hold, no resume. `confirmed_human_verification`
// is always false. The user inspects the redacted screenshot and acknowledges.
export type DominantSurfaceReviewStatus = "pending_review" | "acknowledged" | "expired";

export interface DominantSurfaceReviewView {
  review_id: string;
  status: DominantSurfaceReviewStatus;
  domain: string;
  model_label?: string;
  model_confidence?: number;
  trigger_basis?: string;
  outcome: "uncertain";
  confirmed_human_verification: false;
  raw_surface_revealed_to_agent: false;
  screenshot_available: boolean;
  screenshot_captured_at?: string;
  screenshot_expires_at?: string;
  created_at: string;
  expires_at: string;
}

export const listDominantSurfaceReviews = () =>
  vgcRequest<{ ok: true; data: DominantSurfaceReviewView[] }>(
    `/api/internal/dominant-surface-reviews`,
  );

export const getDominantSurfaceReviewScreenshot = (reviewId: string) =>
  vgcRequest<{ ok: true } & VisualGestureCapsuleScreenshot>(
    `/api/internal/dominant-surface-reviews/${reviewId}/screenshot`,
  );

export const acknowledgeDominantSurfaceReview = (reviewId: string) =>
  vgcRequest<{ ok: true; data: DominantSurfaceReviewView }>(
    `/api/internal/dominant-surface-reviews/${reviewId}/acknowledge`,
    { method: "POST", body: JSON.stringify({}) },
  );

// ─── Live guided press-and-hold (hold-start → heartbeat → hold-end) ───────────
//
// The live counterpart to submitVisualGestureCapsuleGesture's single-shot
// press_hold: the browser mouse stays down ONLY while heartbeats keep arriving,
// so the hold is genuine continuous presence — never a recorded duration replayed
// after release. Only the normalized press point (fx, fy) leaves the client at
// hold-start; heartbeat and hold-end carry no geometry. Taps still use /gesture.

/** hold-start: holding (mouse down) or challenge_gone (wall already cleared). */
export interface VisualGestureHoldStartResult {
  hold_state: "holding" | "challenge_gone";
  data: VisualGestureCapsuleView;
}

/** heartbeat: holding while live, or a terminal hold signal. */
export interface VisualGestureHeartbeatResult {
  hold_state: "holding" | "released_fail_closed" | "cleared";
}

/** hold-end: the post-release recheck outcome (or too_short under the min hold). */
export interface VisualGestureHoldEndResult {
  hold_state: "cleared" | "still_present" | "inconclusive" | "unknown" | "too_short";
  data: VisualGestureCapsuleView;
}

// cdp_url-free body: only the normalized press point leaves the client.
export const startVisualGestureCapsuleHold = (
  capsuleId: string,
  point: { fx: number; fy: number },
) =>
  vgcRequest<{ ok: true } & VisualGestureHoldStartResult>(
    `/api/internal/visual-gesture-capsules/${capsuleId}/hold-start`,
    { method: "POST", body: JSON.stringify(point) },
  );

export const sendVisualGestureCapsuleHeartbeat = (capsuleId: string) =>
  vgcRequest<{ ok: true } & VisualGestureHeartbeatResult>(
    `/api/internal/visual-gesture-capsules/${capsuleId}/heartbeat`,
    { method: "POST", body: JSON.stringify({}) },
  );

export const endVisualGestureCapsuleHold = (capsuleId: string) =>
  vgcRequest<{ ok: true } & VisualGestureHoldEndResult>(
    `/api/internal/visual-gesture-capsules/${capsuleId}/hold-end`,
    { method: "POST", body: JSON.stringify({}) },
  );

// Development-only smoke helper: creates a fake smoke.test capsule + frame so the
// /human-verification UI can be exercised without a live opaque-HV wall. Backed by
// the NODE_ENV-gated dev route; requires ANTIGEN_VISUAL_GESTURE_CAPSULE=true on the
// API. Returns only the safe capsule view.
export const createVisualGestureCapsuleSmoke = () =>
  vgcRequest<{ ok: true; data: VisualGestureCapsuleView }>(
    `/api/dev/visual-gesture-capsules/smoke`,
    { method: "POST", body: JSON.stringify({}) },
  );
