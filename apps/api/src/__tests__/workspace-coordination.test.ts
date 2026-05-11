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
});
