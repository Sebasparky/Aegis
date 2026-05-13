import { vi } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// agent-api.ts imports several runtime modules that may not be available in test environment.
// Stub the ones that hit external services.
vi.mock("../runtime/authenticatedSessions.js", () => ({
  createAuthenticatedSession: vi.fn(),
  getAuthenticatedSessionHandle: vi.fn(),
  observeAuthenticatedSession: vi.fn(),
  navigateAuthenticatedSession: vi.fn(),
}));
vi.mock("../runtime/secretInjection.js", () => ({
  executeSecretInjectionViaCDP: vi.fn(),
}));
vi.mock("../runtime/challengeInjection.js", () => ({
  challengeCodes: new Map(),
  executeChallengeInjectionViaCDP: vi.fn(),
}));
vi.mock("../runtime/emailChallengeResolver.js", () => ({
  resolutionCodes: new Map(),
  searchGmailForChallengeCode: vi.fn(),
  isEmailChallengeSupported: vi.fn().mockReturnValue(false),
}));
vi.mock("../runtime/observationDryRun.js", () => ({
  runObservationDryRun: vi.fn(),
}));
vi.mock("../routes/website-agent-safety.js", () => ({
  computeWebsiteAgentSafetyProfile: vi.fn(),
}));
vi.mock("../routes/website-aegis-policy.js", () => ({
  getWebsiteAegisPolicyForDomain: vi.fn(),
}));
vi.mock("../repositories/vaultRepository.js", () => ({
  getVaultRepository: vi.fn(() => ({ findByUserId: vi.fn().mockResolvedValue([]) })),
}));
vi.mock("../repositories/receiptRepository.js", () => ({
  getReceiptRepository: vi.fn(() => ({ createReceipt: vi.fn() })),
}));
vi.mock("../lib/kms.js", () => ({
  getKmsProvider: vi.fn(),
}));
vi.mock("../lib/kmsAudit.js", () => ({
  recordKmsAuditEvent: vi.fn(),
}));

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildWorkspaceTestServer,
  seedTestData,
  seedWorkspaceDelegations,
  seedTestWorkspace,
  seedOpenTask,
  seedWorkspaceArtifact,
  seedTrialWorkspace,
  seedCollarRoutingTrial,
  resetStore,
  IDS,
} from "./helpers.js";
import {
  aegisWorkspaces,
  collars,
  agentDelegations,
  workspaceTasks,
  workspaceArtifacts,
  workspaceAuditEvents,
  MOCK_USER_ID,
} from "../store/index.js";

const AUTH_A = `Bearer ${IDS.TOKEN_ALL}`;
const AUTH_B = `Bearer ${IDS.TOKEN_B}`;
const AUTH_OUTSIDER = `Bearer ${IDS.TOKEN_OUTSIDER}`;

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildWorkspaceTestServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  resetStore();
  seedTestData();
  seedWorkspaceDelegations();
});

// ─── 1. Workspace access control ──────────────────────────────────────────────

describe("GET /api/agent/v1/workspaces/:id — access control", () => {
  it("returns workspace metadata for a participant delegation", async () => {
    seedTestWorkspace();

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}`,
      headers: { authorization: AUTH_A },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.workspace_id).toBe(IDS.WORKSPACE);
    expect(body.data.name).toBe("Test Workspace");
  });

  it("never exposes owner_user_id in the response", async () => {
    seedTestWorkspace();

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}`,
      headers: { authorization: AUTH_A },
    });
    const body = res.json();
    expect(body.data).not.toHaveProperty("owner_user_id");
    // Deep check — owner_user_id must not appear anywhere in the payload
    expect(JSON.stringify(body.data)).not.toContain("owner_user_id");
  });

  it("returns 403 for a non-participant delegation", async () => {
    seedTestWorkspace();

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}`,
      headers: { authorization: AUTH_OUTSIDER },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("WORKSPACE_ACCESS_DENIED");
  });

  it("returns 404 for an archived workspace", async () => {
    const ws = seedTestWorkspace();
    ws.status = "archived";
    aegisWorkspaces.set(ws.workspace_id, ws);

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}`,
      headers: { authorization: AUTH_A },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("returns 401 with no token", async () => {
    seedTestWorkspace();

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}`,
    });
    expect(res.statusCode).toBe(401);
  });
});

// ─── 2. Task listing ───────────────────────────────────────────────────────────

describe("GET /api/agent/v1/workspaces/:id/tasks — listing", () => {
  it("returns open tasks for a participant", async () => {
    seedTestWorkspace();
    seedOpenTask("task_001");

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/tasks`,
      headers: { authorization: AUTH_A },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].task_id).toBe("task_001");
    expect(body.data[0].status).toBe("open");
  });

  it("non-participant gets 403 on task list", async () => {
    seedTestWorkspace();
    seedOpenTask("task_001");

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/tasks`,
      headers: { authorization: AUTH_OUTSIDER },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── 3. Task claiming ─────────────────────────────────────────────────────────

describe("PATCH /api/agent/v1/workspaces/:id/tasks/:taskId — claim", () => {
  it("delegation A can claim an open task", async () => {
    seedTestWorkspace();
    seedOpenTask("task_001");

    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/tasks/task_001`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      payload: { action: "claim" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("in_progress");
    expect(body.data.is_mine).toBe(true);
  });

  it("delegation B cannot claim a task already claimed by A", async () => {
    seedTestWorkspace();
    seedOpenTask("task_001");

    // A claims it first
    await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/tasks/task_001`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      payload: { action: "claim" },
    });

    // B tries to claim it
    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/tasks/task_001`,
      headers: { authorization: AUTH_B, "content-type": "application/json" },
      payload: { action: "claim" },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("TASK_ALREADY_CLAIMED");
  });

  it("claiming own task a second time is idempotent", async () => {
    seedTestWorkspace();
    seedOpenTask("task_001");

    await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/tasks/task_001`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      payload: { action: "claim" },
    });

    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/tasks/task_001`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      payload: { action: "claim" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("emits a task_claimed audit event", async () => {
    seedTestWorkspace();
    seedOpenTask("task_001");

    await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/tasks/task_001`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      payload: { action: "claim" },
    });

    const events = Array.from(workspaceAuditEvents.values());
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("task_claimed");
    expect(events[0].task_id).toBe("task_001");
  });
});

// ─── 4. Task completion ────────────────────────────────────────────────────────

describe("PATCH /api/agent/v1/workspaces/:id/tasks/:taskId — complete", () => {
  it("assigned delegation can complete its task", async () => {
    seedTestWorkspace();
    seedOpenTask("task_001");

    await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/tasks/task_001`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      payload: { action: "claim" },
    });

    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/tasks/task_001`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      payload: { action: "complete" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("completed");
    expect(body.data.completed_at).toBeTruthy();
  });

  it("non-assigned delegation cannot complete another delegation's task", async () => {
    seedTestWorkspace();
    // Seed task already assigned to delegation A
    seedOpenTask("task_001", {
      status: "in_progress",
      assigned_delegation_id: IDS.DELEGATION_ALL,
    });

    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/tasks/task_001`,
      headers: { authorization: AUTH_B, "content-type": "application/json" },
      payload: { action: "complete" },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error.code).toBe("TASK_NOT_ASSIGNED");
  });

  it("emits task_claimed and task_completed audit events for a full claim+complete flow", async () => {
    seedTestWorkspace();
    seedOpenTask("task_001");

    await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/tasks/task_001`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      payload: { action: "claim" },
    });
    await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/tasks/task_001`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      payload: { action: "complete" },
    });

    const events = Array.from(workspaceAuditEvents.values()).map((e) => e.event_type);
    expect(events).toContain("task_claimed");
    expect(events).toContain("task_completed");
    expect(workspaceAuditEvents.size).toBe(2);
  });
});

// ─── 5. Artifact creation ──────────────────────────────────────────────────────

describe("POST /api/agent/v1/workspaces/:id/artifacts — create", () => {
  it("participant can create a text artifact", async () => {
    seedTestWorkspace();

    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/artifacts`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      payload: { name: "summary.txt", kind: "text", content: "Hello world" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.artifact_id).toBeTruthy();
    expect(body.data.name).toBe("summary.txt");
    expect(body.data.kind).toBe("text");
  });

  it("POST response never contains artifact content", async () => {
    seedTestWorkspace();

    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/artifacts`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      payload: { name: "summary.txt", kind: "text", content: "Secret summary text" },
    });
    const body = res.json();
    // content must not be in POST response
    expect(body.data).not.toHaveProperty("content");
    expect(JSON.stringify(body.data)).not.toContain("Secret summary text");
  });

  it("rejects artifact content over 50KB", async () => {
    seedTestWorkspace();

    const oversized = "x".repeat(51 * 1024);
    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/artifacts`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      payload: { name: "big.txt", kind: "text", content: oversized },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("ARTIFACT_TOO_LARGE");
  });

  it("rejects invalid artifact kind", async () => {
    seedTestWorkspace();

    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/artifacts`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      payload: { name: "file.pdf", kind: "pdf", content: "data" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_ARTIFACT_KIND");
  });

  it("non-participant cannot create artifact", async () => {
    seedTestWorkspace();

    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/artifacts`,
      headers: { authorization: AUTH_OUTSIDER, "content-type": "application/json" },
      payload: { name: "summary.txt", kind: "text", content: "data" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("WORKSPACE_ACCESS_DENIED");
  });

  it("emits an artifact_created audit event", async () => {
    seedTestWorkspace();

    await server.inject({
      method: "POST",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/artifacts`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      payload: { name: "result.json", kind: "json", content: '{"ok":true}' },
    });

    const events = Array.from(workspaceAuditEvents.values());
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("artifact_created");
    expect(events[0].delegation_id).toBe(IDS.DELEGATION_ALL);
  });
});

// ─── 6. Artifact reading ───────────────────────────────────────────────────────

describe("GET artifact endpoints — read and list", () => {
  it("another participant (delegation B) can read an artifact created by A", async () => {
    seedTestWorkspace();

    // A creates artifact
    const createRes = await server.inject({
      method: "POST",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/artifacts`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      payload: { name: "analysis.md", kind: "markdown", content: "## Analysis\nResults here." },
    });
    const { artifact_id } = createRes.json().data;

    // B reads it
    const readRes = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/artifacts/${artifact_id}`,
      headers: { authorization: AUTH_B },
    });
    expect(readRes.statusCode).toBe(200);
    const body = readRes.json();
    expect(body.ok).toBe(true);
    expect(body.data.content).toBe("## Analysis\nResults here.");
  });

  it("GET list never returns artifact content", async () => {
    seedTestWorkspace();

    await server.inject({
      method: "POST",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/artifacts`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      payload: { name: "notes.txt", kind: "text", content: "Confidential notes" },
    });

    const listRes = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/artifacts`,
      headers: { authorization: AUTH_A },
    });
    expect(listRes.statusCode).toBe(200);
    const body = listRes.json();
    expect(body.data[0]).not.toHaveProperty("content");
    expect(JSON.stringify(body.data)).not.toContain("Confidential notes");
  });

  it("non-participant cannot read artifact", async () => {
    seedTestWorkspace();

    const createRes = await server.inject({
      method: "POST",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/artifacts`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      payload: { name: "data.csv", kind: "csv", content: "a,b\n1,2" },
    });
    const { artifact_id } = createRes.json().data;

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/artifacts/${artifact_id}`,
      headers: { authorization: AUTH_OUTSIDER },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── 7. Full coordination flow ─────────────────────────────────────────────────

describe("Full coordination flow", () => {
  it("A claims a task, completes it, creates an artifact; B reads the artifact", async () => {
    seedTestWorkspace();
    seedOpenTask("task_flow_001");

    // A claims
    const claimRes = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/tasks/task_flow_001`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      payload: { action: "claim" },
    });
    expect(claimRes.statusCode).toBe(200);

    // A creates artifact linked to task
    const artifactRes = await server.inject({
      method: "POST",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/artifacts`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      payload: { name: "output.txt", kind: "text", content: "Task result", task_id: "task_flow_001" },
    });
    expect(artifactRes.statusCode).toBe(201);
    const { artifact_id } = artifactRes.json().data;

    // A completes task
    const completeRes = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/tasks/task_flow_001`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      payload: { action: "complete" },
    });
    expect(completeRes.statusCode).toBe(200);
    expect(completeRes.json().data.status).toBe("completed");

    // B reads the artifact
    const readRes = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/artifacts/${artifact_id}`,
      headers: { authorization: AUTH_B },
    });
    expect(readRes.statusCode).toBe(200);
    expect(readRes.json().data.content).toBe("Task result");

    // Audit trail: 3 events (claim, artifact_created, complete)
    expect(workspaceAuditEvents.size).toBe(3);

    // Workspace shows completed task count
    const wsRes = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}`,
      headers: { authorization: AUTH_B },
    });
    expect(wsRes.json().data.task_counts.completed).toBe(1);
    expect(wsRes.json().data.artifact_count).toBe(1);
  });
});

// ─── 8. Effective permission enforcement ──────────────────────────────────────

const ALL_WS_ACTIONS = [
  "workspace_read", "workspace_task_list", "workspace_task_claim",
  "workspace_task_complete", "workspace_artifact_create",
  "workspace_artifact_list", "workspace_artifact_read",
] as const;

const NOW_PERM = "2026-05-01T00:00:00.000Z";

function seedPermCollar(id: string, opts: {
  allowed?: string[];
  approval_required?: string[];
  blocked?: string[];
  status?: string;
}): void {
  collars.set(id, {
    id,
    user_id: MOCK_USER_ID,
    name: `perm-test-collar-${id}`,
    status: (opts.status ?? "active") as "active" | "revoked" | "archived",
    allowed_actions: (opts.allowed ?? []) as any,
    approval_required_actions: (opts.approval_required ?? []) as any,
    blocked_actions: (opts.blocked ?? []) as any,
    spending_limits: { max_without_approval: 0, max_with_approval: 0, subscriptions_allowed: false },
    counterparty_rules: { sensitive_actions_require_verified_business: false, block_known_prompt_injection_sites: false },
    session_limits: { max_duration_minutes: 60 },
    created_at: NOW_PERM,
    updated_at: NOW_PERM,
  });
}

function seedPermDelegation(delegationId: string, tokenId: string, collarId: string): void {
  agentDelegations.set(delegationId, {
    id: delegationId,
    user_id: MOCK_USER_ID,
    user_aegis_id: "aid_user_001",
    agent_name: `agent_perm_${delegationId}`,
    agent_platform: "api",
    channel: "api",
    default_collar_id: collarId,
    status: "active",
    token_id: tokenId,
    skill_access_mode: "all",
    skill_access_skill_ids: [],
    created_at: NOW_PERM,
    updated_at: NOW_PERM,
  });
}

function seedPermWorkspace(wsId: string, collarId: string, participantIds: string[]): void {
  aegisWorkspaces.set(wsId, {
    workspace_id: wsId,
    owner_user_id: MOCK_USER_ID,
    name: "Perm Test Workspace",
    collar_id: collarId,
    participant_delegation_ids: participantIds,
    status: "active",
    created_at: NOW_PERM,
    updated_at: NOW_PERM,
  });
}

describe("Workspace effective permissions", () => {
  const WS = "ws_perm_001";
  const DEL = "del_perm_001";
  const TOK = "tok_perm_001";
  const WS_COL = "col_ws_perm";
  const DEL_COL = "col_del_perm";

  it("workspace collar blocks workspace_read via blocked_actions", async () => {
    seedPermCollar(WS_COL, { blocked: ["workspace_read"] });
    seedPermCollar(DEL_COL, { allowed: [...ALL_WS_ACTIONS] });
    seedPermDelegation(DEL, TOK, DEL_COL);
    seedPermWorkspace(WS, WS_COL, [DEL]);

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${WS}`,
      headers: { authorization: `Bearer ${TOK}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("WORKSPACE_PERMISSION_DENIED");
  });

  it("workspace collar blocks workspace_task_list via absent action (strict opt-in)", async () => {
    // Workspace collar has no workspace actions in any list
    seedPermCollar(WS_COL, { allowed: ["browse"] });
    seedPermCollar(DEL_COL, { allowed: [...ALL_WS_ACTIONS] });
    seedPermDelegation(DEL, TOK, DEL_COL);
    seedPermWorkspace(WS, WS_COL, [DEL]);

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${WS}/tasks`,
      headers: { authorization: `Bearer ${TOK}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("WORKSPACE_PERMISSION_DENIED");
  });

  it("delegation collar blocks workspace_task_claim via blocked_actions", async () => {
    seedPermCollar(WS_COL, { allowed: [...ALL_WS_ACTIONS] });
    seedPermCollar(DEL_COL, { blocked: ["workspace_task_claim"] });
    seedPermDelegation(DEL, TOK, DEL_COL);
    seedPermWorkspace(WS, WS_COL, [DEL]);
    seedOpenTask("task_perm_001", { workspace_id: WS });

    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${WS}/tasks/task_perm_001`,
      headers: { authorization: `Bearer ${TOK}`, "content-type": "application/json" },
      payload: { action: "claim" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("WORKSPACE_PERMISSION_DENIED");
  });

  it("delegation collar blocks workspace_task_complete via absent action (strict opt-in)", async () => {
    // Delegation collar allows claim but not complete
    seedPermCollar(WS_COL, { allowed: [...ALL_WS_ACTIONS] });
    seedPermCollar(DEL_COL, { allowed: ["workspace_task_claim", "workspace_read", "workspace_task_list"] });
    seedPermDelegation(DEL, TOK, DEL_COL);
    seedPermWorkspace(WS, WS_COL, [DEL]);
    seedOpenTask("task_perm_002", { workspace_id: WS, status: "in_progress", assigned_delegation_id: DEL });

    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${WS}/tasks/task_perm_002`,
      headers: { authorization: `Bearer ${TOK}`, "content-type": "application/json" },
      payload: { action: "complete" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("WORKSPACE_PERMISSION_DENIED");
  });

  it("workspace collar approval_required returns WORKSPACE_PERMISSION_REQUIRES_APPROVAL", async () => {
    seedPermCollar(WS_COL, { approval_required: ["workspace_artifact_create"] });
    seedPermCollar(DEL_COL, { allowed: [...ALL_WS_ACTIONS] });
    seedPermDelegation(DEL, TOK, DEL_COL);
    seedPermWorkspace(WS, WS_COL, [DEL]);

    const res = await server.inject({
      method: "POST",
      url: `/api/agent/v1/workspaces/${WS}/artifacts`,
      headers: { authorization: `Bearer ${TOK}`, "content-type": "application/json" },
      payload: { name: "test.txt", kind: "text", content: "hello" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("WORKSPACE_PERMISSION_REQUIRES_APPROVAL");
  });

  it("delegation collar approval_required returns WORKSPACE_PERMISSION_REQUIRES_APPROVAL", async () => {
    seedPermCollar(WS_COL, { allowed: [...ALL_WS_ACTIONS] });
    seedPermCollar(DEL_COL, { approval_required: ["workspace_task_claim"], allowed: ["workspace_read", "workspace_task_list"] });
    seedPermDelegation(DEL, TOK, DEL_COL);
    seedPermWorkspace(WS, WS_COL, [DEL]);
    seedOpenTask("task_perm_003", { workspace_id: WS });

    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${WS}/tasks/task_perm_003`,
      headers: { authorization: `Bearer ${TOK}`, "content-type": "application/json" },
      payload: { action: "claim" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("WORKSPACE_PERMISSION_REQUIRES_APPROVAL");
  });

  it("both collars allow — operation succeeds", async () => {
    seedPermCollar(WS_COL, { allowed: [...ALL_WS_ACTIONS] });
    seedPermCollar(DEL_COL, { allowed: [...ALL_WS_ACTIONS] });
    seedPermDelegation(DEL, TOK, DEL_COL);
    seedPermWorkspace(WS, WS_COL, [DEL]);

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${WS}`,
      headers: { authorization: `Bearer ${TOK}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("inactive delegation collar returns WORKSPACE_COLLAR_INACTIVE", async () => {
    seedPermCollar(WS_COL, { allowed: [...ALL_WS_ACTIONS] });
    seedPermCollar(DEL_COL, { allowed: [...ALL_WS_ACTIONS], status: "revoked" });
    seedPermDelegation(DEL, TOK, DEL_COL);
    seedPermWorkspace(WS, WS_COL, [DEL]);

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${WS}`,
      headers: { authorization: `Bearer ${TOK}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("WORKSPACE_COLLAR_INACTIVE");
  });

  it("non-participant is denied before permission evaluation", async () => {
    // Workspace collar allows all — but the delegation is not a participant
    seedPermCollar(WS_COL, { allowed: [...ALL_WS_ACTIONS] });
    seedPermCollar(DEL_COL, { allowed: [...ALL_WS_ACTIONS] });
    seedPermDelegation(DEL, TOK, DEL_COL);
    // Workspace with empty participant list
    seedPermWorkspace(WS, WS_COL, []);

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${WS}`,
      headers: { authorization: `Bearer ${TOK}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("WORKSPACE_ACCESS_DENIED");
  });

  it("invalid PATCH action returns INVALID_ACTION regardless of collar permissions", async () => {
    seedPermCollar(WS_COL, { allowed: [...ALL_WS_ACTIONS] });
    seedPermCollar(DEL_COL, { allowed: [...ALL_WS_ACTIONS] });
    seedPermDelegation(DEL, TOK, DEL_COL);
    seedPermWorkspace(WS, WS_COL, [DEL]);
    seedOpenTask("task_perm_004", { workspace_id: WS });

    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${WS}/tasks/task_perm_004`,
      headers: { authorization: `Bearer ${TOK}`, "content-type": "application/json" },
      payload: { action: "bogus" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_ACTION");
  });

  it("claim uses workspace_task_claim permission, not workspace_task_complete", async () => {
    // Collar allows complete but not claim
    seedPermCollar(WS_COL, { allowed: ["workspace_task_complete", "workspace_read", "workspace_task_list"] });
    seedPermCollar(DEL_COL, { allowed: [...ALL_WS_ACTIONS] });
    seedPermDelegation(DEL, TOK, DEL_COL);
    seedPermWorkspace(WS, WS_COL, [DEL]);
    seedOpenTask("task_perm_005", { workspace_id: WS });

    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${WS}/tasks/task_perm_005`,
      headers: { authorization: `Bearer ${TOK}`, "content-type": "application/json" },
      payload: { action: "claim" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("WORKSPACE_PERMISSION_DENIED");
  });
});

// ─── 9. Workspace manifest ─────────────────────────────────────────────────────

describe("GET /api/agent/v1/workspaces/:id/manifest", () => {
  // ─ Auth ──────────────────────────────────────────────────────────────────────

  it("returns 401 with no token", async () => {
    seedTestWorkspace();
    const res = await server.inject({ method: "GET", url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest` });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 for a non-participant delegation", async () => {
    seedTestWorkspace();
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_OUTSIDER },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("WORKSPACE_ACCESS_DENIED");
  });

  it("returns 404 for an archived workspace", async () => {
    const ws = seedTestWorkspace();
    ws.status = "archived";
    aegisWorkspaces.set(ws.workspace_id, ws);
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("WORKSPACE_NOT_FOUND");
  });

  // ─ Shape ─────────────────────────────────────────────────────────────────────

  it("returns ok:true with all top-level keys", async () => {
    seedTestWorkspace();
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data).toHaveProperty("workspace");
    expect(data).toHaveProperty("identity");
    expect(data).toHaveProperty("effective_permissions");
    expect(data).toHaveProperty("task_summary");
    expect(data).toHaveProperty("recommended_work_queue");
    expect(data).toHaveProperty("artifacts");
    expect(data).toHaveProperty("workflow_rules");
    expect(data).toHaveProperty("operations");
    expect(data).toHaveProperty("next_actions");
  });

  it("never exposes owner_user_id", async () => {
    seedTestWorkspace();
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    expect(JSON.stringify(res.json().data)).not.toContain("owner_user_id");
  });

  it("never exposes participant_delegation_ids", async () => {
    seedTestWorkspace();
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    expect(JSON.stringify(res.json().data)).not.toContain("participant_delegation_ids");
  });

  it("never exposes artifact content", async () => {
    seedTestWorkspace();
    workspaceArtifacts.set("art_manifest_001", {
      artifact_id: "art_manifest_001",
      workspace_id: IDS.WORKSPACE,
      name: "test.md",
      kind: "markdown",
      content: "secret content",
      created_by_delegation_id: IDS.DELEGATION_ALL,
      created_at: "2026-05-01T00:00:00.000Z",
    });
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    expect(res.statusCode).toBe(200);
    const artifacts = res.json().data.artifacts as Record<string, unknown>[];
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).not.toHaveProperty("content");
  });

  it("does not emit an audit event", async () => {
    seedTestWorkspace();
    workspaceAuditEvents.clear();
    await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    expect(workspaceAuditEvents.size).toBe(0);
  });

  // ─ Identity ──────────────────────────────────────────────────────────────────

  it("identity matches calling delegation", async () => {
    seedTestWorkspace();
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    const { identity } = res.json().data;
    expect(identity.delegation_id).toBe(IDS.DELEGATION_ALL);
    expect(identity.agent_name).toBe("agent_demo_001");
  });

  // ─ Effective permissions ──────────────────────────────────────────────────────

  it("effective_permissions has all 7 action keys with valid verdicts", async () => {
    seedTestWorkspace();
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    const ep = res.json().data.effective_permissions;
    const validVerdicts = new Set(["allow", "step_up_required", "blocked"]);
    for (const action of ALL_WS_ACTIONS) {
      expect(ep).toHaveProperty(action);
      expect(validVerdicts.has(ep[action])).toBe(true);
    }
  });

  it("shows 'allow' for all 7 actions with a permissive collar", async () => {
    seedTestWorkspace(); // uses collar_demo_starter which allows all 7
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    const ep = res.json().data.effective_permissions;
    for (const action of ALL_WS_ACTIONS) {
      expect(ep[action]).toBe("allow");
    }
  });

  it("shows 'blocked' when workspace collar hard-blocks an action", async () => {
    const WS2 = "ws_manifest_perm_001";
    const WS_COL2 = "col_manifest_ws_001";
    const DEL2 = "del_manifest_001";
    const TOK2 = "tok_manifest_001";
    const DEL_COL2 = "col_manifest_del_001";

    // Workspace collar allows all except workspace_task_claim (blocked)
    seedPermCollar(WS_COL2, {
      allowed: ALL_WS_ACTIONS.filter((a) => a !== "workspace_task_claim") as string[],
      blocked: ["workspace_task_claim"],
    });
    seedPermCollar(DEL_COL2, { allowed: [...ALL_WS_ACTIONS] });
    seedPermDelegation(DEL2, TOK2, DEL_COL2);
    seedPermWorkspace(WS2, WS_COL2, [DEL2]);

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${WS2}/manifest`,
      headers: { authorization: `Bearer ${TOK2}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.effective_permissions.workspace_task_claim).toBe("blocked");
  });

  it("shows 'step_up_required' when delegation collar requires approval for an action", async () => {
    const WS3 = "ws_manifest_perm_002";
    const WS_COL3 = "col_manifest_ws_002";
    const DEL3 = "del_manifest_002";
    const TOK3 = "tok_manifest_002";
    const DEL_COL3 = "col_manifest_del_002";

    seedPermCollar(WS_COL3, { allowed: [...ALL_WS_ACTIONS] });
    // Delegation collar requires approval for workspace_artifact_create
    seedPermCollar(DEL_COL3, {
      allowed: ALL_WS_ACTIONS.filter((a) => a !== "workspace_artifact_create") as string[],
      approval_required: ["workspace_artifact_create"],
    });
    seedPermDelegation(DEL3, TOK3, DEL_COL3);
    seedPermWorkspace(WS3, WS_COL3, [DEL3]);

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${WS3}/manifest`,
      headers: { authorization: `Bearer ${TOK3}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.effective_permissions.workspace_artifact_create).toBe("step_up_required");
  });

  // ─ Task summary ───────────────────────────────────────────────────────────────

  it("task_summary.open includes open tasks", async () => {
    seedTestWorkspace();
    seedOpenTask("task_manifest_a");
    seedOpenTask("task_manifest_b");
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    const openIds = res.json().data.task_summary.open.map((t: { task_id: string }) => t.task_id);
    expect(openIds).toContain("task_manifest_a");
    expect(openIds).toContain("task_manifest_b");
  });

  it("task_summary.mine contains tasks assigned to the calling delegation", async () => {
    seedTestWorkspace();
    seedOpenTask("task_manifest_mine", {
      status: "in_progress",
      assigned_delegation_id: IDS.DELEGATION_ALL,
    });
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    const mine = res.json().data.task_summary.mine as { task_id: string }[];
    expect(mine.some((t) => t.task_id === "task_manifest_mine")).toBe(true);
  });

  it("task_summary.mine is empty for a delegation that has no assigned tasks", async () => {
    seedTestWorkspace();
    seedOpenTask("task_manifest_other", {
      status: "in_progress",
      assigned_delegation_id: IDS.DELEGATION_ALL,
    });
    // AUTH_B is delegation_b — not assigned
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_B },
    });
    expect(res.json().data.task_summary.mine).toHaveLength(0);
  });

  it("recently_completed returns at most 3 tasks in descending completed_at order", async () => {
    seedTestWorkspace();
    const timestamps = [
      "2026-05-01T01:00:00.000Z",
      "2026-05-01T02:00:00.000Z",
      "2026-05-01T03:00:00.000Z",
      "2026-05-01T04:00:00.000Z",
    ];
    timestamps.forEach((ts, i) =>
      seedOpenTask(`task_done_${i}`, {
        status: "completed",
        assigned_delegation_id: IDS.DELEGATION_ALL,
        completed_at: ts,
        updated_at: ts,
      }),
    );
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    const rc = res.json().data.task_summary.recently_completed as { task_id: string; completed_at: string }[];
    expect(rc).toHaveLength(3);
    // Most recent first
    expect(rc[0].completed_at >= rc[1].completed_at).toBe(true);
    expect(rc[1].completed_at >= rc[2].completed_at).toBe(true);
  });

  it("task items never expose created_by_user_id", async () => {
    seedTestWorkspace();
    seedOpenTask("task_manifest_user_check");
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    const payload = JSON.stringify(res.json().data.task_summary);
    expect(payload).not.toContain("created_by_user_id");
  });

  // ─ Operations catalog ─────────────────────────────────────────────────────────

  it("operations catalog has exactly 7 entries", async () => {
    seedTestWorkspace();
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    expect(res.json().data.operations).toHaveLength(7);
  });

  it("operations.available is false for blocked actions", async () => {
    const WS4 = "ws_manifest_ops_001";
    const WS_COL4 = "col_manifest_ws_ops_001";
    const DEL4 = "del_manifest_ops_001";
    const TOK4 = "tok_manifest_ops_001";
    const DEL_COL4 = "col_manifest_del_ops_001";

    seedPermCollar(WS_COL4, {
      allowed: ALL_WS_ACTIONS.filter((a) => a !== "workspace_task_claim" && a !== "workspace_task_complete") as string[],
      blocked: ["workspace_task_claim", "workspace_task_complete"],
    });
    seedPermCollar(DEL_COL4, { allowed: [...ALL_WS_ACTIONS] });
    seedPermDelegation(DEL4, TOK4, DEL_COL4);
    seedPermWorkspace(WS4, WS_COL4, [DEL4]);

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${WS4}/manifest`,
      headers: { authorization: `Bearer ${TOK4}` },
    });
    const ops = res.json().data.operations as { path: string; available: boolean }[];
    const patchEntry = ops.find((o) => o.path.includes("/tasks/{taskId}"));
    expect(patchEntry?.available).toBe(false);
  });

  // ─ next_actions ───────────────────────────────────────────────────────────────

  it("next_actions includes a claim hint when open tasks exist and claim is allowed", async () => {
    seedTestWorkspace();
    seedOpenTask("task_nxt_open");
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    const hints: string[] = res.json().data.next_actions;
    expect(hints.some((h) => h.toLowerCase().includes("claim"))).toBe(true);
  });

  it("next_actions does not include a claim hint when workspace_task_claim is blocked", async () => {
    const WS5 = "ws_manifest_nxt_001";
    const WS_COL5 = "col_manifest_ws_nxt_001";
    const DEL5 = "del_manifest_nxt_001";
    const TOK5 = "tok_manifest_nxt_001";
    const DEL_COL5 = "col_manifest_del_nxt_001";

    seedPermCollar(WS_COL5, {
      allowed: ALL_WS_ACTIONS.filter((a) => a !== "workspace_task_claim") as string[],
      blocked: ["workspace_task_claim"],
    });
    seedPermCollar(DEL_COL5, { allowed: [...ALL_WS_ACTIONS] });
    seedPermDelegation(DEL5, TOK5, DEL_COL5);
    seedPermWorkspace(WS5, WS_COL5, [DEL5]);
    seedOpenTask("task_nxt_blocked", { workspace_id: WS5 });

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${WS5}/manifest`,
      headers: { authorization: `Bearer ${TOK5}` },
    });
    const hints: string[] = res.json().data.next_actions;
    expect(hints.some((h) => h.toLowerCase().includes("claim"))).toBe(false);
  });

  // ─ workflow_rules ─────────────────────────────────────────────────────────────

  it("workflow_rules is a non-empty array of strings", async () => {
    seedTestWorkspace();
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    const rules: unknown[] = res.json().data.workflow_rules;
    expect(Array.isArray(rules)).toBe(true);
    expect(rules.length).toBeGreaterThanOrEqual(4);
    rules.forEach((r) => expect(typeof r).toBe("string"));
  });

  // ─ Operations body_schema ─────────────────────────────────────────────────────

  it("POST /artifacts operation has body_schema with name, kind, content, task_id", async () => {
    seedTestWorkspace();
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    expect(res.statusCode).toBe(200);
    const ops = res.json().data.operations as { method: string; path: string; body_schema?: Record<string, string> }[];
    const postArtifacts = ops.find((o) => o.method === "POST" && o.path.includes("/artifacts"));
    expect(postArtifacts).toBeDefined();
    expect(postArtifacts?.body_schema).toBeDefined();
    expect(postArtifacts?.body_schema?.name).toContain("required");
    expect(postArtifacts?.body_schema?.kind).toContain("markdown");
    expect(postArtifacts?.body_schema?.content).toContain("required");
    expect(postArtifacts?.body_schema?.task_id).toContain("optional");
  });

  it("PATCH /tasks operation has body_schema with action field", async () => {
    seedTestWorkspace();
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    expect(res.statusCode).toBe(200);
    const ops = res.json().data.operations as { method: string; path: string; body_schema?: Record<string, string> }[];
    const patchTasks = ops.find((o) => o.method === "PATCH" && o.path.includes("/tasks/"));
    expect(patchTasks).toBeDefined();
    expect(patchTasks?.body_schema).toBeDefined();
    expect(patchTasks?.body_schema?.action).toBeDefined();
  });
});

// ─── 10. Task eligibility — claim enforcement ─────────────────────────────────

// Helpers scoped to these tests to avoid ID collisions
const ELG = {
  WS: "ws_elg_001",
  WS_COL: "col_elg_ws_001",
  // Agent A: collar_demo_starter (IDS.COLLAR)
  DEL_A: IDS.DELEGATION_ALL,
  TOK_A: IDS.TOKEN_ALL,
  // Agent B: a distinct collar (col_elg_b)
  DEL_B: "delg_elg_b",
  TOK_B: "tok_elg_b",
  COL_B: "col_elg_b",
  // Outsider
  DEL_OUT: IDS.DELEGATION_OUTSIDER,
  TOK_OUT: IDS.TOKEN_OUTSIDER,
} as const;

/** Seeds the eligibility workspace with Agent A (IDS.COLLAR) and Agent B (ELG.COL_B) as participants. */
function seedEligibilityWorkspace(): void {
  // Workspace collar: full permissions
  seedPermCollar(ELG.WS_COL, { allowed: [...ALL_WS_ACTIONS] });
  // Agent B delegation with its own collar
  seedPermCollar(ELG.COL_B, { allowed: [...ALL_WS_ACTIONS] });
  seedPermDelegation(ELG.DEL_B, ELG.TOK_B, ELG.COL_B);
  // Workspace with both agents
  seedPermWorkspace(ELG.WS, ELG.WS_COL, [ELG.DEL_A, ELG.DEL_B]);
}

describe("PATCH .../tasks/:taskId — claim eligibility", () => {
  // ─ Open tasks (backward compat) ──────────────────────────────────────────────

  it("open task with no assignment_type is claimable by any participant", async () => {
    seedEligibilityWorkspace();
    seedOpenTask("task_elg_open_001", { workspace_id: ELG.WS });

    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${ELG.WS}/tasks/task_elg_open_001`,
      headers: { authorization: `Bearer ${ELG.TOK_A}`, "content-type": "application/json" },
      payload: { action: "claim" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("in_progress");
  });

  it("open task with assignment_type='open' is claimable by any participant", async () => {
    seedEligibilityWorkspace();
    seedOpenTask("task_elg_open_002", { workspace_id: ELG.WS, assignment_type: "open" });

    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${ELG.WS}/tasks/task_elg_open_002`,
      headers: { authorization: `Bearer ${ELG.TOK_B}`, "content-type": "application/json" },
      payload: { action: "claim" },
    });
    expect(res.statusCode).toBe(200);
  });

  // ─ Delegation-assigned tasks ──────────────────────────────────────────────────

  it("delegation-assigned task is claimable only by the assigned delegation", async () => {
    seedEligibilityWorkspace();
    seedOpenTask("task_elg_del_001", {
      workspace_id: ELG.WS,
      assignment_type: "delegation",
      assigned_delegation_id: ELG.DEL_A,
    });

    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${ELG.WS}/tasks/task_elg_del_001`,
      headers: { authorization: `Bearer ${ELG.TOK_A}`, "content-type": "application/json" },
      payload: { action: "claim" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.assigned_delegation_id).toBe(ELG.DEL_A);
  });

  it("delegation-assigned task returns TASK_NOT_ELIGIBLE for another delegation", async () => {
    seedEligibilityWorkspace();
    seedOpenTask("task_elg_del_002", {
      workspace_id: ELG.WS,
      assignment_type: "delegation",
      assigned_delegation_id: ELG.DEL_A,
    });

    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${ELG.WS}/tasks/task_elg_del_002`,
      headers: { authorization: `Bearer ${ELG.TOK_B}`, "content-type": "application/json" },
      payload: { action: "claim" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("TASK_NOT_ELIGIBLE");
  });

  it("delegation-assigned task: re-claiming own in_progress task is idempotent", async () => {
    seedEligibilityWorkspace();
    seedOpenTask("task_elg_del_idem", {
      workspace_id: ELG.WS,
      assignment_type: "delegation",
      assigned_delegation_id: ELG.DEL_A,
      status: "in_progress",
    });

    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${ELG.WS}/tasks/task_elg_del_idem`,
      headers: { authorization: `Bearer ${ELG.TOK_A}`, "content-type": "application/json" },
      payload: { action: "claim" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.is_mine).toBe(true);
  });

  it("in_progress task owned by another returns TASK_ALREADY_CLAIMED, not TASK_NOT_ELIGIBLE", async () => {
    seedEligibilityWorkspace();
    seedOpenTask("task_elg_taken", {
      workspace_id: ELG.WS,
      status: "in_progress",
      assigned_delegation_id: ELG.DEL_A,
    });

    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${ELG.WS}/tasks/task_elg_taken`,
      headers: { authorization: `Bearer ${ELG.TOK_B}`, "content-type": "application/json" },
      payload: { action: "claim" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("TASK_ALREADY_CLAIMED");
    expect(res.json().error.recovery_hint).toBe("refresh_manifest");
  });

  // ─ Collar-required tasks ──────────────────────────────────────────────────────

  it("collar-required task is claimable by a delegation with matching default_collar_id", async () => {
    seedEligibilityWorkspace();
    seedOpenTask("task_elg_col_001", {
      workspace_id: ELG.WS,
      assignment_type: "collar",
      required_collar_id: ELG.COL_B,
    });

    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${ELG.WS}/tasks/task_elg_col_001`,
      headers: { authorization: `Bearer ${ELG.TOK_B}`, "content-type": "application/json" },
      payload: { action: "claim" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.assigned_delegation_id).toBe(ELG.DEL_B);
  });

  it("collar-required task returns TASK_NOT_ELIGIBLE for non-matching collar", async () => {
    seedEligibilityWorkspace();
    seedOpenTask("task_elg_col_002", {
      workspace_id: ELG.WS,
      assignment_type: "collar",
      required_collar_id: ELG.COL_B,
    });

    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${ELG.WS}/tasks/task_elg_col_002`,
      headers: { authorization: `Bearer ${ELG.TOK_A}`, "content-type": "application/json" },
      payload: { action: "claim" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("TASK_NOT_ELIGIBLE");
  });

  it("collar-required task returns TASK_NOT_ELIGIBLE when required collar is inactive", async () => {
    seedEligibilityWorkspace();
    // Override the collar to inactive; use Agent A (active collar) as the requester so that
    // checkWorkspacePermission passes and checkTaskEligibility fires the liveness check.
    seedPermCollar(ELG.COL_B, { allowed: [...ALL_WS_ACTIONS], status: "revoked" });
    seedOpenTask("task_elg_col_inactive", {
      workspace_id: ELG.WS,
      assignment_type: "collar",
      required_collar_id: ELG.COL_B,
    });

    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${ELG.WS}/tasks/task_elg_col_inactive`,
      headers: { authorization: `Bearer ${ELG.TOK_A}`, "content-type": "application/json" },
      payload: { action: "claim" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("TASK_NOT_ELIGIBLE");
  });
});

// ─── 11. Task eligibility — manifest buckets ──────────────────────────────────

describe("GET .../manifest — task eligibility buckets", () => {
  it("delegation-type task pre-assigned to caller appears in assigned_to_me", async () => {
    seedEligibilityWorkspace();
    seedOpenTask("task_mb_atm_001", {
      workspace_id: ELG.WS,
      assignment_type: "delegation",
      assigned_delegation_id: ELG.DEL_A,
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${ELG.WS}/manifest`,
      headers: { authorization: `Bearer ${ELG.TOK_A}` },
    });
    expect(res.statusCode).toBe(200);
    const { task_summary } = res.json().data;
    expect(task_summary.assigned_to_me.some((t: { task_id: string }) => t.task_id === "task_mb_atm_001")).toBe(true);
    expect(task_summary.open).toHaveLength(0);
    expect(task_summary.eligible).toHaveLength(0);
  });

  it("delegation-type task pre-assigned to other delegation does not appear in assigned_to_me", async () => {
    seedEligibilityWorkspace();
    seedOpenTask("task_mb_atm_002", {
      workspace_id: ELG.WS,
      assignment_type: "delegation",
      assigned_delegation_id: ELG.DEL_A,
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${ELG.WS}/manifest`,
      headers: { authorization: `Bearer ${ELG.TOK_B}` },
    });
    const { task_summary } = res.json().data;
    expect(task_summary.assigned_to_me).toHaveLength(0);
    expect(task_summary.not_eligible.some((t: { task_id: string }) => t.task_id === "task_mb_atm_002")).toBe(true);
  });

  it("collar-type task with matching collar appears in eligible", async () => {
    seedEligibilityWorkspace();
    seedOpenTask("task_mb_el_001", {
      workspace_id: ELG.WS,
      assignment_type: "collar",
      required_collar_id: ELG.COL_B,
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${ELG.WS}/manifest`,
      headers: { authorization: `Bearer ${ELG.TOK_B}` },
    });
    const { task_summary } = res.json().data;
    expect(task_summary.eligible.some((t: { task_id: string }) => t.task_id === "task_mb_el_001")).toBe(true);
    expect(task_summary.not_eligible).toHaveLength(0);
  });

  it("collar-type task with non-matching collar appears in not_eligible with reason", async () => {
    seedEligibilityWorkspace();
    seedOpenTask("task_mb_nel_001", {
      workspace_id: ELG.WS,
      assignment_type: "collar",
      required_collar_id: ELG.COL_B,
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${ELG.WS}/manifest`,
      headers: { authorization: `Bearer ${ELG.TOK_A}` },
    });
    const { task_summary } = res.json().data;
    expect(task_summary.eligible).toHaveLength(0);
    const nel = task_summary.not_eligible as { task_id: string; reason: string }[];
    const entry = nel.find((t) => t.task_id === "task_mb_nel_001");
    expect(entry).toBeDefined();
    expect(entry!.reason).toContain(ELG.COL_B);
  });

  it("not_eligible reason for other-delegation task is 'assigned_to_other_delegation'", async () => {
    seedEligibilityWorkspace();
    seedOpenTask("task_mb_nel_del", {
      workspace_id: ELG.WS,
      assignment_type: "delegation",
      assigned_delegation_id: ELG.DEL_A,
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${ELG.WS}/manifest`,
      headers: { authorization: `Bearer ${ELG.TOK_B}` },
    });
    const nel = res.json().data.task_summary.not_eligible as { task_id: string; reason: string }[];
    const entry = nel.find((t) => t.task_id === "task_mb_nel_del");
    expect(entry!.reason).toBe("assigned_to_other_delegation");
  });

  it("open-type tasks appear only in open bucket", async () => {
    seedEligibilityWorkspace();
    seedOpenTask("task_mb_open_001", { workspace_id: ELG.WS });

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${ELG.WS}/manifest`,
      headers: { authorization: `Bearer ${ELG.TOK_A}` },
    });
    const { task_summary } = res.json().data;
    expect(task_summary.open.some((t: { task_id: string }) => t.task_id === "task_mb_open_001")).toBe(true);
    expect(task_summary.assigned_to_me).toHaveLength(0);
    expect(task_summary.eligible).toHaveLength(0);
  });

  it("in_progress task claimed by caller appears in mine", async () => {
    seedEligibilityWorkspace();
    seedOpenTask("task_mb_mine_001", {
      workspace_id: ELG.WS,
      status: "in_progress",
      assigned_delegation_id: ELG.DEL_A,
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${ELG.WS}/manifest`,
      headers: { authorization: `Bearer ${ELG.TOK_A}` },
    });
    const { task_summary } = res.json().data;
    expect(task_summary.mine.some((t: { task_id: string }) => t.task_id === "task_mb_mine_001")).toBe(true);
  });

  it("collar-required task with inactive collar appears in not_eligible with reason 'required_collar_inactive_or_missing'", async () => {
    seedEligibilityWorkspace();
    seedPermCollar(ELG.COL_B, { allowed: [...ALL_WS_ACTIONS], status: "revoked" });
    seedOpenTask("task_mb_inactive_col", {
      workspace_id: ELG.WS,
      assignment_type: "collar",
      required_collar_id: ELG.COL_B,
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${ELG.WS}/manifest`,
      headers: { authorization: `Bearer ${ELG.TOK_A}` },
    });
    const nel = res.json().data.task_summary.not_eligible as { task_id: string; reason: string }[];
    const entry = nel.find((t) => t.task_id === "task_mb_inactive_col");
    expect(entry!.reason).toBe("required_collar_inactive_or_missing");
  });

  it("not_eligible tasks never expose owner_user_id or participant_delegation_ids", async () => {
    seedEligibilityWorkspace();
    seedOpenTask("task_mb_sec_001", {
      workspace_id: ELG.WS,
      assignment_type: "delegation",
      assigned_delegation_id: ELG.DEL_A,
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${ELG.WS}/manifest`,
      headers: { authorization: `Bearer ${ELG.TOK_B}` },
    });
    const payload = JSON.stringify(res.json().data);
    expect(payload).not.toContain("owner_user_id");
    expect(payload).not.toContain("participant_delegation_ids");
  });

  // ─ next_actions priority ──────────────────────────────────────────────────────

  it("next_actions: assigned_to_me hint fires before eligible hint", async () => {
    seedEligibilityWorkspace();
    // Agent A: has an assigned task and also an eligible open task
    seedPermCollar("col_elg_a_extra", { allowed: [...ALL_WS_ACTIONS] });
    seedOpenTask("task_nxt_atm", {
      workspace_id: ELG.WS,
      assignment_type: "delegation",
      assigned_delegation_id: ELG.DEL_A,
    });
    // Give Agent A a second collar match via open-type task (not eligible bucket, but open)
    seedOpenTask("task_nxt_open", { workspace_id: ELG.WS });

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${ELG.WS}/manifest`,
      headers: { authorization: `Bearer ${ELG.TOK_A}` },
    });
    const hints: string[] = res.json().data.next_actions;
    const atm = hints.findIndex((h) => h.toLowerCase().includes("assigned"));
    const open = hints.findIndex((h) => h.toLowerCase().includes("open task"));
    expect(atm).toBeGreaterThanOrEqual(0);
    // assigned hint exists; open hint suppressed because assigned_to_me is non-empty
    expect(open).toBe(-1);
  });

  it("next_actions: eligible hint fires before open hint", async () => {
    seedEligibilityWorkspace();
    seedOpenTask("task_nxt_el", {
      workspace_id: ELG.WS,
      assignment_type: "collar",
      required_collar_id: ELG.COL_B,
    });
    seedOpenTask("task_nxt_open_b", { workspace_id: ELG.WS });

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${ELG.WS}/manifest`,
      headers: { authorization: `Bearer ${ELG.TOK_B}` },
    });
    const hints: string[] = res.json().data.next_actions;
    const el = hints.findIndex((h) => h.toLowerCase().includes("eligible"));
    const open = hints.findIndex((h) => h.toLowerCase().includes("open task"));
    expect(el).toBeGreaterThanOrEqual(0);
    // open hint suppressed when eligible is non-empty and mine is empty
    expect(open).toBe(-1);
  });

  it("next_actions: no claim hint when workspace_task_claim is blocked even with assigned_to_me task", async () => {
    const WS6 = "ws_elg_nxt_blocked";
    const WS_COL6 = "col_elg_ws_nxt_blocked";
    const DEL6 = "del_elg_nxt_blocked";
    const TOK6 = "tok_elg_nxt_blocked";
    const DEL_COL6 = "col_elg_del_nxt_blocked";

    seedPermCollar(WS_COL6, {
      allowed: ALL_WS_ACTIONS.filter((a) => a !== "workspace_task_claim") as string[],
      blocked: ["workspace_task_claim"],
    });
    seedPermCollar(DEL_COL6, { allowed: [...ALL_WS_ACTIONS] });
    seedPermDelegation(DEL6, TOK6, DEL_COL6);
    seedPermWorkspace(WS6, WS_COL6, [DEL6]);
    seedOpenTask("task_nxt_blocked", {
      workspace_id: WS6,
      assignment_type: "delegation",
      assigned_delegation_id: DEL6,
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${WS6}/manifest`,
      headers: { authorization: `Bearer ${TOK6}` },
    });
    const hints: string[] = res.json().data.next_actions;
    expect(hints.some((h) => h.toLowerCase().includes("claim"))).toBe(false);
  });
});

// ─── Section 12: recommended_work_queue in manifest ──────────────────────────

describe("Section 12: recommended_work_queue in manifest", () => {
  beforeEach(() => {
    resetStore();
    seedTestData();
    seedWorkspaceDelegations();
    seedTestWorkspace();
  });

  it("recommended_work_queue is present and is an array", async () => {
    seedOpenTask("task_rwq_basic");
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(Array.isArray(data.recommended_work_queue)).toBe(true);
  });

  it("each entry has required shape fields", async () => {
    seedOpenTask("task_rwq_shape");
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    const queue: unknown[] = res.json().data.recommended_work_queue;
    expect(queue.length).toBeGreaterThan(0);
    const entry = queue[0] as Record<string, unknown>;
    expect(entry).toHaveProperty("task_id");
    expect(entry).toHaveProperty("title");
    expect(entry).toHaveProperty("task_kind");
    expect(entry).toHaveProperty("task_mode");
    expect(entry).toHaveProperty("priority");
    expect(entry).toHaveProperty("status");
    expect(entry).toHaveProperty("eligibility");
    expect(entry).toHaveProperty("readiness");
    expect(entry).toHaveProperty("recommended_action");
    expect(entry).toHaveProperty("reason");
  });

  it("open task with no deps gets readiness=ready and recommended_action=claim", async () => {
    seedOpenTask("task_rwq_ready");
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    const queue = res.json().data.recommended_work_queue as Record<string, unknown>[];
    const entry = queue.find((e) => e.task_id === "task_rwq_ready");
    expect(entry?.readiness).toBe("ready");
    expect(entry?.recommended_action).toBe("claim");
  });

  it("open task with incomplete dep gets readiness=blocked with blocker_reasons", async () => {
    seedOpenTask("task_rwq_dep_a");
    seedOpenTask("task_rwq_dep_b", { depends_on_task_ids: ["task_rwq_dep_a"] });
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    const queue = res.json().data.recommended_work_queue as Record<string, unknown>[];
    const entry = queue.find((e) => e.task_id === "task_rwq_dep_b") as Record<string, unknown>;
    expect(entry.readiness).toBe("blocked");
    expect(entry.recommended_action).toBe("wait");
    const blockers = entry.blocker_reasons as Record<string, unknown>;
    expect(blockers.incomplete_dependency_task_ids).toContain("task_rwq_dep_a");
  });

  it("open task with missing required artifact gets readiness=blocked", async () => {
    seedOpenTask("task_rwq_art_blocked", { required_artifact_names: ["missing.md"] });
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    const queue = res.json().data.recommended_work_queue as Record<string, unknown>[];
    const entry = queue.find((e) => e.task_id === "task_rwq_art_blocked") as Record<string, unknown>;
    expect(entry.readiness).toBe("blocked");
    const blockers = entry.blocker_reasons as Record<string, unknown>;
    expect(blockers.missing_artifact_names).toContain("missing.md");
  });

  it("task with completed dep gets readiness=ready", async () => {
    seedOpenTask("task_rwq_dep_done", { status: "completed", completed_at: "2026-05-01T01:00:00.000Z" });
    seedOpenTask("task_rwq_after_done", { depends_on_task_ids: ["task_rwq_dep_done"] });
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    const queue = res.json().data.recommended_work_queue as Record<string, unknown>[];
    const entry = queue.find((e) => e.task_id === "task_rwq_after_done");
    expect(entry?.readiness).toBe("ready");
  });

  it("task with required artifact present gets readiness=ready", async () => {
    seedWorkspaceArtifact("art_rwq_001", "present.md");
    seedOpenTask("task_rwq_art_ready", { required_artifact_names: ["present.md"] });
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    const queue = res.json().data.recommended_work_queue as Record<string, unknown>[];
    const entry = queue.find((e) => e.task_id === "task_rwq_art_ready");
    expect(entry?.readiness).toBe("ready");
  });

  it("in_progress task owned by caller gets readiness=in_progress_mine and recommended_action=continue_work", async () => {
    seedOpenTask("task_rwq_mine", {
      status: "in_progress",
      assigned_delegation_id: IDS.DELEGATION_ALL,
    });
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    const queue = res.json().data.recommended_work_queue as Record<string, unknown>[];
    const entry = queue.find((e) => e.task_id === "task_rwq_mine");
    expect(entry?.readiness).toBe("in_progress_mine");
    expect(entry?.recommended_action).toBe("continue_work");
  });

  it("in_progress task owned by other gets readiness=in_progress_other and recommended_action=wait", async () => {
    seedOpenTask("task_rwq_other", {
      status: "in_progress",
      assigned_delegation_id: IDS.DELEGATION_B,
    });
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    const queue = res.json().data.recommended_work_queue as Record<string, unknown>[];
    const entry = queue.find((e) => e.task_id === "task_rwq_other");
    expect(entry?.readiness).toBe("in_progress_other");
    expect(entry?.recommended_action).toBe("wait");
  });

  it("sort: in_progress_mine appears before ready eligible tasks", async () => {
    seedOpenTask("task_rwq_ready_first", { created_at: "2026-05-01T00:00:00.000Z" });
    seedOpenTask("task_rwq_mine_sort", {
      status: "in_progress",
      assigned_delegation_id: IDS.DELEGATION_ALL,
    });
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    const queue = res.json().data.recommended_work_queue as Record<string, unknown>[];
    const mineIdx = queue.findIndex((e) => e.task_id === "task_rwq_mine_sort");
    const readyIdx = queue.findIndex((e) => e.task_id === "task_rwq_ready_first");
    expect(mineIdx).toBeGreaterThanOrEqual(0);
    expect(readyIdx).toBeGreaterThanOrEqual(0);
    expect(mineIdx).toBeLessThan(readyIdx);
  });

  it("sort: urgent priority task appears before high priority task in ready tier", async () => {
    seedOpenTask("task_rwq_high", { priority: "high", created_at: "2026-04-30T00:00:00.000Z" });
    seedOpenTask("task_rwq_urgent", { priority: "urgent", created_at: "2026-05-01T00:00:00.000Z" });
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    const queue = res.json().data.recommended_work_queue as Record<string, unknown>[];
    const urgentIdx = queue.findIndex((e) => e.task_id === "task_rwq_urgent");
    const highIdx = queue.findIndex((e) => e.task_id === "task_rwq_high");
    expect(urgentIdx).toBeLessThan(highIdx);
  });

  it("sort: higher unblock count sorts before same-priority task with lower unblock count", async () => {
    // task_rwq_unblock_a is depended on by 2 other tasks; task_rwq_unblock_b by 0
    seedOpenTask("task_rwq_unblock_a", { priority: "normal", created_at: "2026-05-01T00:00:00.000Z" });
    seedOpenTask("task_rwq_unblock_b", { priority: "normal", created_at: "2026-05-01T00:00:00.000Z" });
    seedOpenTask("task_rwq_dep_1", { depends_on_task_ids: ["task_rwq_unblock_a"], status: "completed", completed_at: "2026-05-01T01:00:00.000Z" });
    seedOpenTask("task_rwq_dep_2", { depends_on_task_ids: ["task_rwq_unblock_a"], status: "completed", completed_at: "2026-05-01T01:00:00.000Z" });
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    const queue = res.json().data.recommended_work_queue as Record<string, unknown>[];
    const aIdx = queue.findIndex((e) => e.task_id === "task_rwq_unblock_a");
    const bIdx = queue.findIndex((e) => e.task_id === "task_rwq_unblock_b");
    expect(aIdx).toBeLessThan(bIdx);
  });

  it("not_eligible task gets eligibility=not_eligible, recommended_action=none, and appears after eligible tasks", async () => {
    // Seed a collar that AUTH_A's delegation does not carry
    const SPECIAL_COLLAR = "col_rwq_special";
    seedPermCollar(SPECIAL_COLLAR, { allowed: ["workspace_read", "workspace_task_list", "workspace_task_claim",
      "workspace_task_complete", "workspace_artifact_create", "workspace_artifact_list", "workspace_artifact_read"] });
    seedOpenTask("task_rwq_not_eligible", { assignment_type: "collar", required_collar_id: SPECIAL_COLLAR });
    seedOpenTask("task_rwq_eligible_open");
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A }, // AUTH_A uses collar_demo_starter, not SPECIAL_COLLAR
    });
    const queue = res.json().data.recommended_work_queue as Record<string, unknown>[];
    const notElEntry = queue.find((e) => e.task_id === "task_rwq_not_eligible") as Record<string, unknown>;
    const eligibleEntry = queue.find((e) => e.task_id === "task_rwq_eligible_open");
    expect(notElEntry.eligibility).toBe("not_eligible");
    expect(notElEntry.recommended_action).toBe("none");
    const notElIdx = queue.findIndex((e) => e.task_id === "task_rwq_not_eligible");
    const eligibleIdx = queue.findIndex((e) => e.task_id === "task_rwq_eligible_open");
    expect(eligibleIdx).toBeLessThan(notElIdx);
    expect(eligibleEntry).toBeDefined();
  });

  it("task_kind and task_mode are carried through to manifest entry", async () => {
    seedOpenTask("task_rwq_kind", { task_kind: "research", task_mode: "plan_first" });
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    const queue = res.json().data.recommended_work_queue as Record<string, unknown>[];
    const entry = queue.find((e) => e.task_id === "task_rwq_kind");
    expect(entry?.task_kind).toBe("research");
    expect(entry?.task_mode).toBe("plan_first");
  });

  it("task with no kind or priority fields defaults to task_kind=other and priority=normal", async () => {
    seedOpenTask("task_rwq_defaults");
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    const queue = res.json().data.recommended_work_queue as Record<string, unknown>[];
    const entry = queue.find((e) => e.task_id === "task_rwq_defaults");
    expect(entry?.task_kind).toBe("other");
    expect(entry?.priority).toBe("normal");
    expect(entry?.task_mode).toBe("direct");
  });

  it("blocked tasks appear after ready tasks in the queue", async () => {
    seedOpenTask("task_rwq_dep_blocker");
    seedOpenTask("task_rwq_blocked_by_dep", { depends_on_task_ids: ["task_rwq_dep_blocker"] });
    seedOpenTask("task_rwq_ready_sibling");
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/manifest`,
      headers: { authorization: AUTH_A },
    });
    const queue = res.json().data.recommended_work_queue as Record<string, unknown>[];
    const blockedIdx = queue.findIndex((e) => e.task_id === "task_rwq_blocked_by_dep");
    const readyIdx = queue.findIndex((e) => e.task_id === "task_rwq_ready_sibling");
    expect(readyIdx).toBeLessThan(blockedIdx);
  });
});

// ─── Section 13: Claim with TASK_NOT_READY denial ────────────────────────────

describe("Section 13: Claim blocked/ready/ineligible behavior", () => {
  beforeEach(() => {
    resetStore();
    seedTestData();
    seedWorkspaceDelegations();
    seedTestWorkspace();
  });

  it("claiming a dep-blocked task returns 409 TASK_NOT_READY with blocker_reasons", async () => {
    seedOpenTask("task_clm_dep_a");
    seedOpenTask("task_clm_dep_b", { depends_on_task_ids: ["task_clm_dep_a"] });

    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/tasks/task_clm_dep_b`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      body: JSON.stringify({ action: "claim" }),
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("TASK_NOT_READY");
    expect(body.error.recovery_hint).toBe("refresh_manifest");
    expect(body.blocker_reasons.incomplete_dependency_task_ids).toContain("task_clm_dep_a");
  });

  it("claiming a task blocked by missing artifact returns 409 TASK_NOT_READY with missing_artifact_names", async () => {
    seedOpenTask("task_clm_art_blocked", { required_artifact_names: ["required.md"] });

    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/tasks/task_clm_art_blocked`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      body: JSON.stringify({ action: "claim" }),
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("TASK_NOT_READY");
    expect(body.blocker_reasons.missing_artifact_names).toContain("required.md");
  });

  it("claiming a ready task succeeds with HTTP 200 and no blocker_reasons", async () => {
    seedOpenTask("task_clm_ready");

    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/tasks/task_clm_ready`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      body: JSON.stringify({ action: "claim" }),
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.status).toBe("in_progress");
    expect(data).not.toHaveProperty("blocker_reasons");
  });

  it("not-eligible task returns 403 TASK_NOT_ELIGIBLE before readiness is checked", async () => {
    const SPECIAL_COLLAR2 = "col_clm_special";
    seedPermCollar(SPECIAL_COLLAR2, { allowed: ["workspace_read", "workspace_task_list", "workspace_task_claim",
      "workspace_task_complete", "workspace_artifact_create", "workspace_artifact_list", "workspace_artifact_read"] });
    // Task is also dep-blocked but should fail with TASK_NOT_ELIGIBLE first
    seedOpenTask("task_clm_ineligible", {
      assignment_type: "collar",
      required_collar_id: SPECIAL_COLLAR2,
      depends_on_task_ids: ["nonexistent_dep"],
    });

    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/tasks/task_clm_ineligible`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      body: JSON.stringify({ action: "claim" }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("TASK_NOT_ELIGIBLE");
  });

  it("claiming a blocked task that becomes ready after dep completes succeeds", async () => {
    seedOpenTask("task_clm_will_complete");
    seedOpenTask("task_clm_after", { depends_on_task_ids: ["task_clm_will_complete"] });

    // First attempt while dep is open — should fail
    const res1 = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/tasks/task_clm_after`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      body: JSON.stringify({ action: "claim" }),
    });
    expect(res1.statusCode).toBe(409);
    expect(res1.json().error.code).toBe("TASK_NOT_READY");

    // Complete the dependency
    workspaceTasks.get("task_clm_will_complete")!.status = "in_progress";
    workspaceTasks.get("task_clm_will_complete")!.assigned_delegation_id = IDS.DELEGATION_B;
    workspaceTasks.get("task_clm_will_complete")!.status = "completed";
    workspaceTasks.get("task_clm_will_complete")!.completed_at = new Date().toISOString();

    // Second attempt after dep is completed — should succeed
    const res2 = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${IDS.WORKSPACE}/tasks/task_clm_after`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      body: JSON.stringify({ action: "claim" }),
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().data.status).toBe("in_progress");
  });
});

// ─── Section 14: Seed data validation ────────────────────────────────────────

describe("Section 14: Seed data validation", () => {
  beforeEach(() => {
    resetStore();
    seedTestData();
    seedWorkspaceDelegations();
    seedTrialWorkspace();
  });

  it("fresh manifest for ws_coord_trial_001 shows task_coord_002 as blocked", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/ws_coord_trial_001/manifest`,
      headers: { authorization: AUTH_A },
    });
    expect(res.statusCode).toBe(200);
    const queue = res.json().data.recommended_work_queue as Record<string, unknown>[];
    const t002 = queue.find((e) => e.task_id === "task_coord_002") as Record<string, unknown>;
    expect(t002).toBeDefined();
    expect(t002.readiness).toBe("blocked");
    expect(t002.recommended_action).toBe("wait");
    const blockers = t002.blocker_reasons as Record<string, unknown>;
    expect(blockers.incomplete_dependency_task_ids).toContain("task_coord_001");
    expect(blockers.missing_artifact_names).toContain("aegis-pillars-summary.md");
  });

  it("fresh manifest shows task_coord_001 as ready/high priority and task_coord_003 as ready/low priority, with 001 first", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/ws_coord_trial_001/manifest`,
      headers: { authorization: AUTH_A },
    });
    const queue = res.json().data.recommended_work_queue as Record<string, unknown>[];
    const t001Idx = queue.findIndex((e) => e.task_id === "task_coord_001");
    const t003Idx = queue.findIndex((e) => e.task_id === "task_coord_003");
    const t001 = queue[t001Idx] as Record<string, unknown>;
    const t003 = queue[t003Idx] as Record<string, unknown>;
    expect(t001.readiness).toBe("ready");
    expect(t001.recommended_action).toBe("claim");
    expect(t001.priority).toBe("high");
    expect(t003.readiness).toBe("ready");
    expect(t003.recommended_action).toBe("claim");
    expect(t003.priority).toBe("low");
    expect(t001Idx).toBeLessThan(t003Idx);
  });

  it("claiming task_coord_002 before task_coord_001 is complete returns TASK_NOT_READY", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/ws_coord_trial_001/tasks/task_coord_002`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      body: JSON.stringify({ action: "claim" }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("TASK_NOT_READY");
  });

  it("task_coord_002 becomes ready after completing task_coord_001 and creating aegis-pillars-summary.md", async () => {
    // Complete the dependency
    const t001 = workspaceTasks.get("task_coord_001")!;
    t001.status = "in_progress";
    t001.assigned_delegation_id = IDS.DELEGATION_ALL;
    workspaceTasks.set("task_coord_001", t001);
    t001.status = "completed";
    t001.completed_at = new Date().toISOString();
    workspaceTasks.set("task_coord_001", t001);

    // Create the required artifact
    workspaceArtifacts.set("art_seed_summary", {
      artifact_id: "art_seed_summary",
      workspace_id: "ws_coord_trial_001",
      name: "aegis-pillars-summary.md",
      kind: "markdown",
      content: "# Aegis Pillars",
      task_id: "task_coord_001",
      created_by_delegation_id: IDS.DELEGATION_ALL,
      created_at: new Date().toISOString(),
    });

    // Manifest should now show task_coord_002 as ready
    const manifestRes = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/ws_coord_trial_001/manifest`,
      headers: { authorization: AUTH_A },
    });
    const queue = manifestRes.json().data.recommended_work_queue as Record<string, unknown>[];
    const t002 = queue.find((e) => e.task_id === "task_coord_002");
    expect(t002?.readiness).toBe("ready");
    expect(t002?.recommended_action).toBe("claim");

    // Claim should also succeed
    const claimRes = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/ws_coord_trial_001/tasks/task_coord_002`,
      headers: { authorization: AUTH_A, "content-type": "application/json" },
      body: JSON.stringify({ action: "claim" }),
    });
    expect(claimRes.statusCode).toBe(200);
    expect(claimRes.json().data.status).toBe("in_progress");
  });
});

// ─── Section 15: Collar Routing Trial ────────────────────────────────────────

describe("Section 15: Collar Routing Trial", () => {
  const AUTH_RESEARCH = "Bearer tok_routing_research";
  const AUTH_REVIEW = "Bearer tok_routing_review";
  const WS = "ws_routing_trial";

  beforeEach(() => {
    resetStore();
    seedTestData();
    seedCollarRoutingTrial();
  });

  it("research agent manifest: task_routing_001 eligible/ready, task_routing_002 not_eligible, task_routing_003 open/ready", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${WS}/manifest`,
      headers: { authorization: AUTH_RESEARCH },
    });
    expect(res.statusCode).toBe(200);
    const queue = res.json().data.recommended_work_queue as Record<string, unknown>[];

    const t001 = queue.find((e) => e.task_id === "task_routing_001") as Record<string, unknown>;
    expect(t001.eligibility).toBe("eligible");
    expect(t001.readiness).toBe("ready");
    expect(t001.recommended_action).toBe("claim");

    const t002 = queue.find((e) => e.task_id === "task_routing_002") as Record<string, unknown>;
    expect(t002.eligibility).toBe("not_eligible");
    expect(t002.recommended_action).toBe("none");
    const blockers002 = t002.blocker_reasons as Record<string, unknown>;
    expect(String(blockers002.not_eligible_reason ?? "")).toContain("col_routing_review");

    const t003 = queue.find((e) => e.task_id === "task_routing_003") as Record<string, unknown>;
    expect(t003.eligibility).toBe("open");
    expect(t003.readiness).toBe("ready");
  });

  it("review agent manifest: task_routing_001 not_eligible, task_routing_002 eligible/blocked, task_routing_003 open/ready", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${WS}/manifest`,
      headers: { authorization: AUTH_REVIEW },
    });
    expect(res.statusCode).toBe(200);
    const queue = res.json().data.recommended_work_queue as Record<string, unknown>[];

    const t001 = queue.find((e) => e.task_id === "task_routing_001") as Record<string, unknown>;
    expect(t001.eligibility).toBe("not_eligible");
    const blockers001 = t001.blocker_reasons as Record<string, unknown>;
    expect(String(blockers001.not_eligible_reason ?? "")).toContain("col_routing_research");

    const t002 = queue.find((e) => e.task_id === "task_routing_002") as Record<string, unknown>;
    expect(t002.eligibility).toBe("eligible");
    expect(t002.readiness).toBe("blocked");
    expect(t002.recommended_action).toBe("wait");
    const blockers002 = t002.blocker_reasons as Record<string, unknown>;
    expect(blockers002.incomplete_dependency_task_ids as string[]).toContain("task_routing_001");
    expect(blockers002.missing_artifact_names as string[]).toContain("routing-summary.md");

    const t003 = queue.find((e) => e.task_id === "task_routing_003") as Record<string, unknown>;
    expect(t003.eligibility).toBe("open");
    expect(t003.readiness).toBe("ready");
  });

  it("research agent can claim task_routing_001 → 200 in_progress", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${WS}/tasks/task_routing_001`,
      headers: { authorization: AUTH_RESEARCH, "content-type": "application/json" },
      body: JSON.stringify({ action: "claim" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("in_progress");
    expect(res.json().data.assigned_delegation_id).toBe("delg_routing_research");
  });

  it("research agent cannot claim task_routing_002 → 403 TASK_NOT_ELIGIBLE", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${WS}/tasks/task_routing_002`,
      headers: { authorization: AUTH_RESEARCH, "content-type": "application/json" },
      body: JSON.stringify({ action: "claim" }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("TASK_NOT_ELIGIBLE");
  });

  it("review agent cannot claim task_routing_001 → 403 TASK_NOT_ELIGIBLE", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${WS}/tasks/task_routing_001`,
      headers: { authorization: AUTH_REVIEW, "content-type": "application/json" },
      body: JSON.stringify({ action: "claim" }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("TASK_NOT_ELIGIBLE");
  });

  it("review agent cannot claim task_routing_002 before task_routing_001 completes → 409 TASK_NOT_READY", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${WS}/tasks/task_routing_002`,
      headers: { authorization: AUTH_REVIEW, "content-type": "application/json" },
      body: JSON.stringify({ action: "claim" }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("TASK_NOT_READY");
    const blockers = res.json().blocker_reasons as Record<string, unknown>;
    expect(blockers.incomplete_dependency_task_ids as string[]).toContain("task_routing_001");
    expect(blockers.missing_artifact_names as string[]).toContain("routing-summary.md");
  });

  it("after task_routing_001 completed + routing-summary.md created, review agent sees task_routing_002 as ready+eligible", async () => {
    const t001 = workspaceTasks.get("task_routing_001")!;
    t001.status = "completed";
    t001.assigned_delegation_id = "delg_routing_research";
    t001.completed_at = new Date().toISOString();
    workspaceTasks.set("task_routing_001", t001);
    workspaceArtifacts.set("art_routing_summary", {
      artifact_id: "art_routing_summary",
      workspace_id: WS,
      name: "routing-summary.md",
      kind: "markdown",
      content: "# Routing Summary",
      task_id: "task_routing_001",
      created_by_delegation_id: "delg_routing_research",
      created_at: new Date().toISOString(),
    });

    const res = await server.inject({
      method: "GET",
      url: `/api/agent/v1/workspaces/${WS}/manifest`,
      headers: { authorization: AUTH_REVIEW },
    });
    const queue = res.json().data.recommended_work_queue as Record<string, unknown>[];
    const t002 = queue.find((e) => e.task_id === "task_routing_002") as Record<string, unknown>;
    expect(t002.eligibility).toBe("eligible");
    expect(t002.readiness).toBe("ready");
    expect(t002.recommended_action).toBe("claim");
  });

  it("review agent claims task_routing_002 after readiness met → 200 in_progress", async () => {
    const t001 = workspaceTasks.get("task_routing_001")!;
    t001.status = "completed";
    t001.assigned_delegation_id = "delg_routing_research";
    t001.completed_at = new Date().toISOString();
    workspaceTasks.set("task_routing_001", t001);
    workspaceArtifacts.set("art_routing_summary_2", {
      artifact_id: "art_routing_summary_2",
      workspace_id: WS,
      name: "routing-summary.md",
      kind: "markdown",
      content: "# Routing Summary",
      task_id: "task_routing_001",
      created_by_delegation_id: "delg_routing_research",
      created_at: new Date().toISOString(),
    });

    const res = await server.inject({
      method: "PATCH",
      url: `/api/agent/v1/workspaces/${WS}/tasks/task_routing_002`,
      headers: { authorization: AUTH_REVIEW, "content-type": "application/json" },
      body: JSON.stringify({ action: "claim" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("in_progress");
    expect(res.json().data.assigned_delegation_id).toBe("delg_routing_review");
  });
});

// ---------------------------------------------------------------------------
// POST /api/workspaces/:id/tasks — input validation
// ---------------------------------------------------------------------------
describe("POST /api/workspaces/:id/tasks — validation", () => {
  let srv: FastifyInstance;

  beforeAll(async () => {
    srv = await buildWorkspaceTestServer();
  });

  beforeEach(() => {
    resetStore();
    seedTestData();
    seedWorkspaceDelegations();
    seedTestWorkspace();
  });

  afterAll(async () => {
    await srv.close();
  });

  function post(body: Record<string, unknown>) {
    return srv.inject({
      method: "POST",
      url: `/api/workspaces/${IDS.WORKSPACE}/tasks`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // --- title ---
  it("rejects missing title → 400 INVALID_TASK_TITLE", async () => {
    const res = await post({});
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_TASK_TITLE");
  });

  it("rejects empty title → 400 INVALID_TASK_TITLE", async () => {
    const res = await post({ title: "   " });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_TASK_TITLE");
  });

  it("rejects title over 200 chars → 400 INVALID_TASK_TITLE", async () => {
    const res = await post({ title: "x".repeat(201) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_TASK_TITLE");
  });

  // --- description ---
  it("rejects description over 2000 chars → 400 INVALID_TASK_DESCRIPTION", async () => {
    const res = await post({ title: "Valid", description: "x".repeat(2001) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_TASK_DESCRIPTION");
  });

  // --- enum fields ---
  it("rejects invalid task_kind → 400 INVALID_TASK_KIND", async () => {
    const res = await post({ title: "T", task_kind: "hacking" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_TASK_KIND");
  });

  it("rejects invalid task_mode → 400 INVALID_TASK_MODE", async () => {
    const res = await post({ title: "T", task_mode: "random" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_TASK_MODE");
  });

  it("rejects invalid priority → 400 INVALID_TASK_PRIORITY", async () => {
    const res = await post({ title: "T", priority: "critical" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_TASK_PRIORITY");
  });

  it("rejects invalid assignment_type → 400 INVALID_ASSIGNMENT_TYPE", async () => {
    const res = await post({ title: "T", assignment_type: "random" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_ASSIGNMENT_TYPE");
  });

  // --- assignment_type="delegation" ---
  it("rejects delegation type without assigned_delegation_id → 400 MISSING_ASSIGNED_DELEGATION", async () => {
    const res = await post({ title: "T", assignment_type: "delegation" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("MISSING_ASSIGNED_DELEGATION");
  });

  it("rejects delegation type with unknown delegation → 400 INVALID_ASSIGNED_DELEGATION", async () => {
    const res = await post({ title: "T", assignment_type: "delegation", assigned_delegation_id: "delg_does_not_exist" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_ASSIGNED_DELEGATION");
  });

  it("rejects delegation type with inactive delegation → 400 INVALID_ASSIGNED_DELEGATION", async () => {
    const d = agentDelegations.get(IDS.DELEGATION_ALL)!;
    agentDelegations.set(d.id, { ...d, status: "revoked" });
    const res = await post({ title: "T", assignment_type: "delegation", assigned_delegation_id: IDS.DELEGATION_ALL });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_ASSIGNED_DELEGATION");
  });

  it("rejects delegation type with non-participant delegation → 400 INVALID_ASSIGNED_DELEGATION", async () => {
    // DELEGATION_OUTSIDER is seeded but not in the workspace participant list
    const res = await post({ title: "T", assignment_type: "delegation", assigned_delegation_id: IDS.DELEGATION_OUTSIDER });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_ASSIGNED_DELEGATION");
  });

  it("accepts delegation type with valid participant → 201", async () => {
    const res = await post({ title: "Delegated Task", assignment_type: "delegation", assigned_delegation_id: IDS.DELEGATION_ALL });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.assignment_type).toBe("delegation");
    expect(res.json().data.assigned_delegation_id).toBe(IDS.DELEGATION_ALL);
  });

  // --- assignment_type="collar" ---
  it("rejects collar type without required_collar_id → 400 MISSING_REQUIRED_COLLAR", async () => {
    const res = await post({ title: "T", assignment_type: "collar" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("MISSING_REQUIRED_COLLAR");
  });

  it("rejects collar type with unknown collar → 400 INVALID_REQUIRED_COLLAR", async () => {
    const res = await post({ title: "T", assignment_type: "collar", required_collar_id: "collar_does_not_exist" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_REQUIRED_COLLAR");
  });

  it("rejects collar type with revoked collar → 400 INVALID_REQUIRED_COLLAR", async () => {
    const c = collars.get(IDS.COLLAR)!;
    collars.set(c.id, { ...c, status: "revoked" });
    const res = await post({ title: "T", assignment_type: "collar", required_collar_id: IDS.COLLAR });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_REQUIRED_COLLAR");
  });

  it("accepts collar type with active collar → 201", async () => {
    const res = await post({ title: "Collar Task", assignment_type: "collar", required_collar_id: IDS.COLLAR });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.assignment_type).toBe("collar");
    expect(res.json().data.required_collar_id).toBe(IDS.COLLAR);
  });

  // --- assignment_type="open" — strip spurious fields ---
  it("strips assigned_delegation_id and required_collar_id for open tasks → 201", async () => {
    const res = await post({
      title: "Open Task",
      assignment_type: "open",
      assigned_delegation_id: IDS.DELEGATION_ALL,
      required_collar_id: IDS.COLLAR,
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.assigned_delegation_id).toBeUndefined();
    expect(data.required_collar_id).toBeUndefined();
  });

  // --- dependencies ---
  it("rejects depends_on_task_ids referencing unknown task → 400 INVALID_TASK_DEPENDENCY", async () => {
    const res = await post({ title: "T", depends_on_task_ids: ["task_does_not_exist"] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_TASK_DEPENDENCY");
  });

  it("deduplicates depends_on_task_ids → 201", async () => {
    seedOpenTask("task_dep_001");
    const res = await post({ title: "T", depends_on_task_ids: ["task_dep_001", "task_dep_001"] });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.depends_on_task_ids).toEqual(["task_dep_001"]);
  });

  // --- required_artifact_names ---
  it("rejects more than 20 required_artifact_names → 400 INVALID_REQUIRED_ARTIFACT_NAME", async () => {
    const res = await post({ title: "T", required_artifact_names: Array.from({ length: 21 }, (_, i) => `artifact-${i}`) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_REQUIRED_ARTIFACT_NAME");
  });

  it("rejects empty required_artifact_name → 400 INVALID_REQUIRED_ARTIFACT_NAME", async () => {
    const res = await post({ title: "T", required_artifact_names: ["valid-name", ""] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_REQUIRED_ARTIFACT_NAME");
  });

  it("rejects whitespace-only required_artifact_name → 400 INVALID_REQUIRED_ARTIFACT_NAME", async () => {
    const res = await post({ title: "T", required_artifact_names: ["   "] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_REQUIRED_ARTIFACT_NAME");
  });

  it("rejects required_artifact_name over 100 chars → 400 INVALID_REQUIRED_ARTIFACT_NAME", async () => {
    const res = await post({ title: "T", required_artifact_names: ["x".repeat(101)] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_REQUIRED_ARTIFACT_NAME");
  });

  it("trims and deduplicates required_artifact_names → 201", async () => {
    const res = await post({ title: "T", required_artifact_names: ["  report.md  ", "report.md", "summary.txt"] });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.required_artifact_names).toEqual(["report.md", "summary.txt"]);
  });

  // --- happy path ---
  it("creates a valid open task with all optional fields → 201", async () => {
    seedOpenTask("task_dep_happy");
    const res = await post({
      title: "  My Task  ",
      description: "A well-formed task.",
      task_kind: "research",
      task_mode: "plan_first",
      priority: "high",
      assignment_type: "open",
      depends_on_task_ids: ["task_dep_happy"],
      required_artifact_names: ["  report.md  ", "summary.txt"],
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.title).toBe("My Task");
    expect(data.task_kind).toBe("research");
    expect(data.priority).toBe("high");
    expect(data.depends_on_task_ids).toEqual(["task_dep_happy"]);
    expect(data.required_artifact_names).toEqual(["report.md", "summary.txt"]);
  });
});
