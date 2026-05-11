import Fastify, { type FastifyInstance } from "fastify";
import { skillRoutes } from "../routes/skills.js";
import { routeRunRoutes } from "../routes/route-runs.js";
import { receiptRoutes } from "../routes/receipts.js";
import { workspaceRoutes } from "../routes/workspaces.js";
import { agentApiRoutes } from "../routes/agent-api.js";
import {
  users,
  collars,
  skills,
  routes,
  installedSkills,
  routeRuns,
  routeRunReceipts,
  agentDelegations,
  aegisWorkspaces,
  workspaceTasks,
  workspaceArtifacts,
  workspaceAuditEvents,
  MOCK_USER_ID,
} from "../store/index.js";
import type {
  AgentDelegation,
  Skill,
  AegisRoute,
  InstalledSkill,
  RouteRun,
  RouteRunStatus,
  AegisWorkspace,
  WorkspaceTask,
} from "@aegis/types";

export const IDS = {
  USER: "user_001",
  COLLAR: "collar_demo_starter",
  DELEGATION_ALL: "delg_demo_001",
  DELEGATION_RESTRICTED: "delg_demo_restricted",
  TOKEN_ALL: "pass_demo_001",
  TOKEN_RESTRICTED: "pass_demo_002",
  SKILL_WIKI: "skill_demo_wikipedia_001",
  SKILL_PURCHASE: "skill_demo_purchase_001",
  SKILL_BLOCKED: "skill_demo_blocked_001",
  ROUTE_WIKI: "route_demo_wikipedia_001",
  ROUTE_PURCHASE: "route_demo_purchase_001",
  ROUTE_BLOCKED: "route_demo_blocked_001",
  // Workspace test IDs
  DELEGATION_B: "delg_test_agent_b",
  TOKEN_B: "token_test_agent_b",
  DELEGATION_OUTSIDER: "delg_test_outsider",
  TOKEN_OUTSIDER: "token_test_outsider",
  WORKSPACE: "ws_test_001",
} as const;

export function resetStore(): void {
  users.clear();
  collars.clear();
  agentDelegations.clear();
  skills.clear();
  installedSkills.clear();
  routes.clear();
  routeRuns.clear();
  routeRunReceipts.clear();
  aegisWorkspaces.clear();
  workspaceTasks.clear();
  workspaceArtifacts.clear();
  workspaceAuditEvents.clear();
}

export function seedTestData(): void {
  const NOW = "2026-05-01T00:00:00.000Z";

  users.set(IDS.USER, {
    id: IDS.USER,
    email: "demo@aegis.local",
    display_name: "Demo User",
    aegis_id: "aid_user_001",
    created_at: NOW,
    updated_at: NOW,
  });

  collars.set(IDS.COLLAR, {
    id: IDS.COLLAR,
    user_id: IDS.USER,
    name: "Research & Action Starter",
    description: "A general-purpose starter collar.",
    purpose: "Safely delegate research tasks.",
    status: "active",
    allowed_actions: [
      "browse", "search", "read", "compare", "draft", "add_to_cart",
      "workspace_read", "workspace_task_list", "workspace_task_claim",
      "workspace_task_complete", "workspace_artifact_create",
      "workspace_artifact_list", "workspace_artifact_read",
    ],
    approval_required_actions: [
      "login",
      "purchase",
      "payment",
      "share_email",
      "share_phone",
      "submit_form",
      "post_publicly",
      "upload_file",
      "send_email",
      "create_account",
    ],
    blocked_actions: [
      "subscription",
      "government_id_upload",
      "identity_disclosure",
      "medical_data_disclosure",
      "financial_data_disclosure",
      "delete_account",
    ],
    spending_limits: { max_without_approval: 0, max_with_approval: 100, subscriptions_allowed: false },
    counterparty_rules: { sensitive_actions_require_verified_business: false, block_known_prompt_injection_sites: true },
    session_limits: { max_duration_minutes: 120, max_active_sessions: 3 },
    created_at: NOW,
    updated_at: NOW,
  });

  const delegationAll: AgentDelegation = {
    id: IDS.DELEGATION_ALL,
    user_id: IDS.USER,
    user_aegis_id: "aid_user_001",
    agent_name: "agent_demo_001",
    agent_platform: "api",
    channel: "api",
    default_collar_id: IDS.COLLAR,
    status: "active",
    token_id: IDS.TOKEN_ALL,
    skill_access_mode: "all",
    skill_access_skill_ids: [],
    created_at: NOW,
    updated_at: NOW,
  };
  agentDelegations.set(delegationAll.id, delegationAll);

  const delegationRestricted: AgentDelegation = {
    id: IDS.DELEGATION_RESTRICTED,
    user_id: IDS.USER,
    user_aegis_id: "aid_user_001",
    agent_name: "agent_demo_restricted",
    agent_platform: "api",
    channel: "api",
    default_collar_id: IDS.COLLAR,
    status: "active",
    token_id: IDS.TOKEN_RESTRICTED,
    skill_access_mode: "only",
    skill_access_skill_ids: [],
    created_at: NOW,
    updated_at: NOW,
  };
  agentDelegations.set(delegationRestricted.id, delegationRestricted);

  const routeWiki: AegisRoute = {
    route_id: IDS.ROUTE_WIKI,
    version: "1.0.0",
    created_at: NOW,
    last_verified_at: NOW,
    creator_aegis_id: "aid_user_001",
    trust_tier: "aegis_scanned",
    domain: "en.wikipedia.org",
    workflow_name: "Wikipedia Search",
    workflow_description: "Search Wikipedia.",
    risk_level: "low",
    required_permissions: ["browse"],
    allowed_actions: ["browse"],
    forbidden_actions: [],
    approval_gates: [],
    confidence_threshold: 0.7,
    steps: [],
    run_count: 0,
    success_rate: 0,
    incident_count: 0,
  };
  routes.set(routeWiki.route_id, routeWiki);

  const routePurchase: AegisRoute = {
    route_id: IDS.ROUTE_PURCHASE,
    version: "1.0.0",
    created_at: NOW,
    last_verified_at: NOW,
    creator_aegis_id: "aid_user_001",
    trust_tier: "aegis_scanned",
    domain: "test.aegis.local",
    workflow_name: "Demo Purchase Route",
    workflow_description: "Purchase action route.",
    risk_level: "high",
    required_permissions: ["purchase"],
    allowed_actions: ["purchase"],
    forbidden_actions: [],
    approval_gates: [],
    confidence_threshold: 0.7,
    steps: [],
    variables: [],
    run_count: 0,
    success_rate: 0,
    incident_count: 0,
  };
  routes.set(routePurchase.route_id, routePurchase);

  const routeBlocked: AegisRoute = {
    route_id: IDS.ROUTE_BLOCKED,
    version: "1.0.0",
    created_at: NOW,
    last_verified_at: NOW,
    creator_aegis_id: "aid_user_001",
    trust_tier: "aegis_scanned",
    domain: "test.aegis.local",
    workflow_name: "Demo Blocked Route",
    workflow_description: "identity_disclosure route.",
    risk_level: "critical",
    required_permissions: ["identity_disclosure"],
    allowed_actions: ["identity_disclosure"],
    forbidden_actions: [],
    approval_gates: [],
    confidence_threshold: 0.7,
    steps: [],
    variables: [],
    run_count: 0,
    success_rate: 0,
    incident_count: 0,
  };
  routes.set(routeBlocked.route_id, routeBlocked);

  const skillWiki: Skill = {
    skill_id: IDS.SKILL_WIKI,
    route_id: IDS.ROUTE_WIKI,
    name: "Wikipedia Search",
    summary: "Search Wikipedia.",
    domain: "en.wikipedia.org",
    risk_level: "low",
    trust_tier: "aegis_scanned",
    required_permissions: ["browse"],
    forbidden_actions: [],
    approval_gates: [],
    created_at: NOW,
    published_at: NOW,
  };
  skills.set(skillWiki.skill_id, skillWiki);

  const skillPurchase: Skill = {
    skill_id: IDS.SKILL_PURCHASE,
    route_id: IDS.ROUTE_PURCHASE,
    name: "Demo Purchase Skill",
    summary: "Purchase.",
    domain: "test.aegis.local",
    risk_level: "high",
    trust_tier: "aegis_scanned",
    required_permissions: ["purchase"],
    forbidden_actions: [],
    approval_gates: [],
    created_at: NOW,
    published_at: NOW,
  };
  skills.set(skillPurchase.skill_id, skillPurchase);

  const skillBlocked: Skill = {
    skill_id: IDS.SKILL_BLOCKED,
    route_id: IDS.ROUTE_BLOCKED,
    name: "Demo Blocked Skill",
    summary: "identity_disclosure.",
    domain: "test.aegis.local",
    risk_level: "critical",
    trust_tier: "aegis_scanned",
    required_permissions: ["identity_disclosure"],
    forbidden_actions: [],
    approval_gates: [],
    created_at: NOW,
    published_at: NOW,
  };
  skills.set(skillBlocked.skill_id, skillBlocked);
}

export function installSkill(skillId: string): InstalledSkill {
  const record: InstalledSkill = {
    installed_skill_id: `inskill_test_${skillId}`,
    skill_id: skillId,
    user_id: IDS.USER,
    installed_at: "2026-05-01T00:00:00.000Z",
    enabled: true,
  };
  installedSkills.set(record.installed_skill_id, record);
  return record;
}

export function injectRun(
  runId: string,
  status: RouteRunStatus,
  overrides: Partial<RouteRun> = {}
): RouteRun {
  const run: RouteRun = {
    run_id: runId,
    skill_id: IDS.SKILL_WIKI,
    route_id: IDS.ROUTE_WIKI,
    installed_skill_id: `inskill_test_${IDS.SKILL_WIKI}`,
    user_id: IDS.USER,
    domain: "en.wikipedia.org",
    status,
    created_at: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
  routeRuns.set(run.run_id, run);
  return run;
}

export async function buildTestServer(): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  await server.register(skillRoutes);
  await server.register(routeRunRoutes);
  await server.register(receiptRoutes);
  await server.ready();
  return server;
}

/** Test server that includes workspace internal + agent-api routes. */
export async function buildWorkspaceTestServer(): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  await server.register(workspaceRoutes);
  await server.register(agentApiRoutes);
  await server.ready();
  return server;
}

/** Seeds the two extra delegations needed for workspace coordination tests. */
export function seedWorkspaceDelegations(): void {
  const NOW = "2026-05-01T00:00:00.000Z";

  const delegationB: AgentDelegation = {
    id: IDS.DELEGATION_B,
    user_id: MOCK_USER_ID,
    user_aegis_id: "aid_user_001",
    agent_name: "agent_test_b",
    agent_platform: "api",
    channel: "api",
    default_collar_id: IDS.COLLAR,
    status: "active",
    token_id: IDS.TOKEN_B,
    skill_access_mode: "all",
    skill_access_skill_ids: [],
    created_at: NOW,
    updated_at: NOW,
  };
  agentDelegations.set(delegationB.id, delegationB);

  const delegationOutsider: AgentDelegation = {
    id: IDS.DELEGATION_OUTSIDER,
    user_id: MOCK_USER_ID,
    user_aegis_id: "aid_user_001",
    agent_name: "agent_test_outsider",
    agent_platform: "api",
    channel: "api",
    default_collar_id: IDS.COLLAR,
    status: "active",
    token_id: IDS.TOKEN_OUTSIDER,
    skill_access_mode: "all",
    skill_access_skill_ids: [],
    created_at: NOW,
    updated_at: NOW,
  };
  agentDelegations.set(delegationOutsider.id, delegationOutsider);
}

/** Seeds a workspace with delegation_all and delegation_b as participants. */
export function seedTestWorkspace(): AegisWorkspace {
  const NOW = "2026-05-01T00:00:00.000Z";
  const workspace: AegisWorkspace = {
    workspace_id: IDS.WORKSPACE,
    owner_user_id: MOCK_USER_ID,
    name: "Test Workspace",
    description: "Workspace for coordination tests",
    collar_id: IDS.COLLAR,
    participant_delegation_ids: [IDS.DELEGATION_ALL, IDS.DELEGATION_B],
    status: "active",
    created_at: NOW,
    updated_at: NOW,
  };
  aegisWorkspaces.set(workspace.workspace_id, workspace);
  return workspace;
}

/** Seeds an open task in the test workspace. */
export function seedOpenTask(taskId: string, overrides: Partial<WorkspaceTask> = {}): WorkspaceTask {
  const NOW = "2026-05-01T00:00:00.000Z";
  const task: WorkspaceTask = {
    task_id: taskId,
    workspace_id: IDS.WORKSPACE,
    title: "Test Task",
    description: "A test task",
    status: "open",
    created_by_user_id: MOCK_USER_ID,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
  workspaceTasks.set(task.task_id, task);
  return task;
}

/** Seeds the ws_coord_trial_001 workspace and its three tasks for Section 14 tests. */
export function seedTrialWorkspace(): void {
  const NOW_TRIAL = "2026-05-11T00:00:00.000Z";
  aegisWorkspaces.set("ws_coord_trial_001", {
    workspace_id: "ws_coord_trial_001",
    owner_user_id: MOCK_USER_ID,
    name: "Coordination Trial Workspace",
    description: "Three-task coordination trial.",
    collar_id: IDS.COLLAR,
    participant_delegation_ids: [IDS.DELEGATION_ALL, IDS.DELEGATION_RESTRICTED],
    status: "active",
    created_at: NOW_TRIAL,
    updated_at: NOW_TRIAL,
  });
  workspaceTasks.set("task_coord_001", {
    task_id: "task_coord_001",
    workspace_id: "ws_coord_trial_001",
    title: "Research Aegis product pillars",
    description: "Write a summary. Create aegis-pillars-summary.md.",
    status: "open",
    assignment_type: "collar",
    required_collar_id: IDS.COLLAR,
    task_kind: "research",
    task_mode: "direct",
    priority: "high",
    depends_on_task_ids: [],
    required_artifact_names: [],
    created_by_user_id: MOCK_USER_ID,
    created_at: "2026-05-11T00:00:00.000Z",
    updated_at: "2026-05-11T00:00:00.000Z",
  });
  workspaceTasks.set("task_coord_002", {
    task_id: "task_coord_002",
    workspace_id: "ws_coord_trial_001",
    title: "Review and prioritize Aegis pillars",
    description: "Read the artifact, write review. Create aegis-pillars-review.md.",
    status: "open",
    assignment_type: "collar",
    required_collar_id: IDS.COLLAR,
    task_kind: "review",
    task_mode: "plan_first",
    priority: "normal",
    depends_on_task_ids: ["task_coord_001"],
    required_artifact_names: ["aegis-pillars-summary.md"],
    created_by_user_id: MOCK_USER_ID,
    created_at: "2026-05-11T00:01:00.000Z",
    updated_at: "2026-05-11T00:01:00.000Z",
  });
  workspaceTasks.set("task_coord_003", {
    task_id: "task_coord_003",
    workspace_id: "ws_coord_trial_001",
    title: "Analyze workspace usage patterns",
    description: "Analyze and create workspace-usage-analysis.md.",
    status: "open",
    assignment_type: "open",
    task_kind: "analysis",
    task_mode: "direct",
    priority: "low",
    depends_on_task_ids: [],
    required_artifact_names: [],
    created_by_user_id: MOCK_USER_ID,
    created_at: "2026-05-11T00:02:00.000Z",
    updated_at: "2026-05-11T00:02:00.000Z",
  });
}

/** Seeds a workspace artifact for readiness tests. */
export function seedWorkspaceArtifact(
  artifactId: string,
  name: string,
  overrides: { workspace_id?: string; kind?: "text" | "json" | "csv" | "markdown"; task_id?: string } = {},
): void {
  workspaceArtifacts.set(artifactId, {
    artifact_id: artifactId,
    workspace_id: overrides.workspace_id ?? IDS.WORKSPACE,
    name,
    kind: overrides.kind ?? "markdown",
    content: `# ${name}`,
    task_id: overrides.task_id,
    created_at: "2026-05-01T00:00:00.000Z",
  });
}
