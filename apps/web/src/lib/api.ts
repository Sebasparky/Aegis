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
} from "@aegis/types";

const BASE = "http://localhost:4000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? "API error");
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
export const patchRoute = (routeId: string, body: { workflow_name?: string; workflow_description?: string }) =>
  request<AegisRoute>(`/api/routes/${routeId}`, { method: "PATCH", body: JSON.stringify(body) });
export const submitRouteForReview = (routeId: string) =>
  request<AegisRoute>(`/api/routes/${routeId}/submit-review`, { method: "POST", body: JSON.stringify({}) });
export const reviewRoute = (routeId: string, decision: "approved" | "rejected", review_note?: string) =>
  request<AegisRoute>(`/api/routes/${routeId}/review`, { method: "POST", body: JSON.stringify({ decision, review_note }) });

// Skills Marketplace
export type SkillWithInstalled = Skill & { installed: boolean };
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
export const listRouteRuns = (params?: { domain?: string; status?: string }) => {
  const entries: [string, string][] = [];
  if (params?.domain) entries.push(["domain", params.domain]);
  if (params?.status) entries.push(["status", params.status]);
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
  error?: string;
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
  event_group?: "all" | "browser" | "credential" | "challenge" | "email";
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
