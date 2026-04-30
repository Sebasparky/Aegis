import type {
  Collar,
  AegisPass,
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

// Reputation
export const getReputationSummary = () => request<ReputationSummary>("/api/reputation/summary");

// AegisID
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

// Website AegisID
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

// Aegis Rails
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

// Action API
export const requestAction = (body: ActionRequest) =>
  request<ActionDecisionResponse>("/api/action/request", {
    method: "POST",
    body: JSON.stringify(body),
  });
