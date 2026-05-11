# Aegis Workspace Trial Runbook

Two real Claude agents coordinate through the Aegis external agent HTTP API.
Agent A authors a product summary artifact. Agent B reads it and produces a follow-on review.
No browser, no UI interaction, no external services — raw HTTP calls only.

---

## Prerequisites

1. Node 20+, npm 10+
2. Run seed: `npm run seed:demo` (from repo root)
3. Start the API: `cd apps/api && npm run dev`
   The server listens on `http://localhost:4000`.
4. Confirm: `curl http://localhost:4000/api/health`

---

## Agent Identities

| Agent   | Bearer Token   | Delegation ID        | Agent Name            |
|---------|----------------|----------------------|-----------------------|
| Agent A | pass_demo_001  | delg_demo_001        | agent_demo_001        |
| Agent B | pass_demo_002  | delg_demo_restricted | agent_demo_restricted |

Both agents share workspace `ws_coord_trial_001` with collar `collar_demo_starter`.
All seven workspace action types are in `allowed_actions` — no approval required for any workspace operation.

---

## Fixed IDs

| Entity         | ID                    |
|----------------|-----------------------|
| Workspace      | ws_coord_trial_001    |
| Task (Agent A) | task_coord_001        |
| Task (Agent B) | task_coord_002        |
| Collar         | collar_demo_starter   |

---

## curl Examples

All requests require `Authorization: Bearer <token>` and target `http://localhost:4000`.

### 1. GET workspace metadata (either agent)

```bash
curl -s -H "Authorization: Bearer pass_demo_001" \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001 | jq .
```

Expected: `ok: true`, `task_counts.open: 2`, `participant_count: 2`.

### 2. GET task list (either agent)

```bash
curl -s -H "Authorization: Bearer pass_demo_001" \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001/tasks | jq .
```

Expected: two tasks with `status: "open"` and `is_mine: false`.

### 3. PATCH — Agent A claims task_coord_001

```bash
curl -s -X PATCH \
  -H "Authorization: Bearer pass_demo_001" \
  -H "Content-Type: application/json" \
  -d '{"action":"claim"}' \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001/tasks/task_coord_001 | jq .
```

Expected: `status: "in_progress"`, `is_mine: true`.

### 4. POST — Agent A creates the summary artifact

```bash
curl -s -X POST \
  -H "Authorization: Bearer pass_demo_001" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "aegis-pillars-summary.md",
    "kind": "markdown",
    "task_id": "task_coord_001",
    "content": "# Aegis Product Pillars\n\n## AegisID\n...\n\n## Delegation and Collars\n...\n\n## Aegis Rails\n...\n\n## Aegis Guard\n...\n\n## Audit Trail\n..."
  }' \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001/artifacts | jq .
```

Expected: HTTP 201, `artifact_id` returned. Content is **not** included in the response.

### 5. PATCH — Agent A completes task_coord_001

```bash
curl -s -X PATCH \
  -H "Authorization: Bearer pass_demo_001" \
  -H "Content-Type: application/json" \
  -d '{"action":"complete"}' \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001/tasks/task_coord_001 | jq .
```

Expected: `status: "completed"`, `completed_at` present.

### 6. GET artifact list — Agent B discovers Agent A's output

```bash
curl -s -H "Authorization: Bearer pass_demo_002" \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001/artifacts | jq .
```

Expected: one artifact with `name: "aegis-pillars-summary.md"`. Capture the `artifact_id`.

### 7. GET artifact content — Agent B reads it

```bash
# Replace <artifact_id> with the ID from step 6
curl -s -H "Authorization: Bearer pass_demo_002" \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001/artifacts/<artifact_id> | jq .
```

Expected: full `content` field present in the response.

After reading, Agent B follows the same pattern: claim task_coord_002 → create `aegis-pillars-review.md` → complete task.

---

## Developer Verification (run before handing to agents)

```bash
# Verify Agent A can access the workspace with open tasks
curl -s -H "Authorization: Bearer pass_demo_001" \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001 | jq '.ok, .data.task_counts'
# Expected: true  { open: 2, in_progress: 0, completed: 0 }

# Verify Agent B can also access it
curl -s -H "Authorization: Bearer pass_demo_002" \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001 | jq '.ok, .data.task_counts'
# Expected: true  { open: 2, in_progress: 0, completed: 0 }

# Verify both tasks are listed
curl -s -H "Authorization: Bearer pass_demo_001" \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001/tasks | jq '[.data[].task_id]'
# Expected: ["task_coord_001", "task_coord_002"]
```

If all three return expected results, the setup is ready.

---

## System Prompt: Agent A

```
You are Agent A in an Aegis workspace coordination trial.

Your identity:
- Bearer token: pass_demo_001
- Workspace: ws_coord_trial_001
- Your task: task_coord_001

The Aegis API base URL is http://localhost:4000.
All requests must include: Authorization: Bearer pass_demo_001
All POST/PATCH requests must also include: Content-Type: application/json

Your instructions — execute each step in order and report the result:

Step 1. GET the workspace to confirm it is active.
  GET /api/agent/v1/workspaces/ws_coord_trial_001

Step 2. GET the task list to see all open tasks.
  GET /api/agent/v1/workspaces/ws_coord_trial_001/tasks

Step 3. Claim task_coord_001.
  PATCH /api/agent/v1/workspaces/ws_coord_trial_001/tasks/task_coord_001
  Body: {"action":"claim"}

Step 4. Write 2-3 sentences each summarizing these five concepts from the task description:
  - AegisID
  - Delegation and Collars
  - Aegis Rails
  - Aegis Guard
  - Audit Trail

Step 5. Create a markdown artifact named "aegis-pillars-summary.md" containing your summaries,
  linked to task_coord_001.
  POST /api/agent/v1/workspaces/ws_coord_trial_001/artifacts
  Body: {
    "name": "aegis-pillars-summary.md",
    "kind": "markdown",
    "task_id": "task_coord_001",
    "content": "<your markdown content>"
  }

Step 6. Mark task_coord_001 as complete.
  PATCH /api/agent/v1/workspaces/ws_coord_trial_001/tasks/task_coord_001
  Body: {"action":"complete"}

Step 7. Report: the artifact_id created, the final task status, and the workspace task_counts.

Do not ask for clarification. Execute all steps sequentially.
```

---

## System Prompt: Agent B

```
You are Agent B in an Aegis workspace coordination trial.

Your identity:
- Bearer token: pass_demo_002
- Workspace: ws_coord_trial_001
- Your task: task_coord_002

The Aegis API base URL is http://localhost:4000.
All requests must include: Authorization: Bearer pass_demo_002
All POST/PATCH requests must also include: Content-Type: application/json

Your instructions — execute each step in order and report the result:

Step 1. GET the workspace to confirm it is active.
  GET /api/agent/v1/workspaces/ws_coord_trial_001

Step 2. GET the task list and confirm task_coord_001 has status "completed".
  GET /api/agent/v1/workspaces/ws_coord_trial_001/tasks
  If task_coord_001 is not yet completed, report that and stop — Agent A must finish first.

Step 3. Claim task_coord_002.
  PATCH /api/agent/v1/workspaces/ws_coord_trial_001/tasks/task_coord_002
  Body: {"action":"claim"}

Step 4. List workspace artifacts to find Agent A's output.
  GET /api/agent/v1/workspaces/ws_coord_trial_001/artifacts
  Find the artifact named "aegis-pillars-summary.md" and record its artifact_id.

Step 5. Read Agent A's artifact using the artifact_id from Step 4.
  GET /api/agent/v1/workspaces/ws_coord_trial_001/artifacts/<artifact_id>

Step 6. Based on what you read: identify the single most important capability described.
  Write a 3-bullet-point argument for why that capability matters.

Step 7. Create a markdown artifact named "aegis-pillars-review.md" linked to task_coord_002.
  POST /api/agent/v1/workspaces/ws_coord_trial_001/artifacts
  Body: {
    "name": "aegis-pillars-review.md",
    "kind": "markdown",
    "task_id": "task_coord_002",
    "content": "<your markdown content, identifying the pillar and 3 arguments>"
  }

Step 8. Mark task_coord_002 as complete.
  PATCH /api/agent/v1/workspaces/ws_coord_trial_001/tasks/task_coord_002
  Body: {"action":"complete"}

Step 9. Report: which pillar you chose, your 3 arguments, the artifact_id created, and final task_counts.

Do not ask for clarification. Execute all steps sequentially.
```

---

## Things to Observe (Checklist)

1. [ ] After `seed:demo`, both agents can GET the workspace and receive `task_counts.open: 2`. Confirms the collar fix (workspace actions now in `allowed_actions`).
2. [ ] Both agents see both tasks in the task list with `is_mine: false` before claiming.
3. [ ] After Agent A claims task_coord_001, `is_mine: true` for Agent A, `is_mine: false` for Agent B on that same task.
4. [ ] Agent B attempting to claim task_coord_001 (already `in_progress`) receives 409 `TASK_ALREADY_CLAIMED`. Tests single-owner enforcement.
5. [ ] `POST /artifacts` returns 201 with no `content` field — content omitted on create by design.
6. [ ] Agent B's artifact list shows `created_by_delegation_id: "delg_demo_001"` on Agent A's artifact — cross-agent provenance visible.
7. [ ] Agent B can read the full `content` of Agent A's artifact — cross-agent read permitted under shared collar.
8. [ ] Agent A attempting to complete task_coord_002 receives 403 `TASK_NOT_ASSIGNED`. Task completion is delegation-scoped.
9. [ ] Final workspace shows `task_counts: {open: 0, in_progress: 0, completed: 2}`.
10. [ ] A request with an invalid bearer token (e.g., `Bearer bad_token`) returns 401 `INVALID_TOKEN` on every endpoint.
11. [ ] A request from a token not in `participant_delegation_ids` returns 403 `WORKSPACE_ACCESS_DENIED`.
12. [ ] Agent B's review artifact references a specific concept from Agent A's summary — proves Agent B actually read the content rather than fabricating a response.

---

## Observed Roadblocks (fill in during trial)

| Endpoint | Behavior | Notes |
|----------|----------|-------|
|          |          |       |

**Questions to answer after the trial:**
- Does the agent understand task claiming (vs. just starting work)?
- Does it know when to create an artifact vs. when to just respond in chat?
- Does it recover from a 403 permission error?
- Does it understand the cross-agent handoff (listing artifacts, not guessing IDs)?
- Does it need task dependencies surfaced in the API response?
- Does it need artifact summaries (name + kind + size) rather than just metadata?
- Does it need better endpoint discovery (a workspace manifest endpoint)?
- Would MCP tools reduce friction enough to be worth building?
- Does raw HTTP work at all, or is prompt overhead too high?
