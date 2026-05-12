# Aegis Workspace Trial Runbook

## Current Trial Status

| Trial | Status | Date |
|-------|--------|------|
| Trial 1: Basic coordination (Agent A → artifact → Agent B) | Passed | 2026-05-11 |
| Trial 2: Collar-routing (research collar / review collar / open task) | Passed | 2026-05-11 |
| Trial 3: Concurrent real-agent trial (two live Claude agents, collar routing, task_coord_003 contention) | Passed | 2026-05-11/12 |
| Workspace Manifest Operations Schema + 409 Recovery Hints | Applied | 2026-05-12 |

Friction addressed after Trial 3: agents used `content_type` instead of `kind` on artifact POST. Fixed by adding `body_schema` to manifest operations stubs (POST /artifacts and PATCH /tasks). `TASK_ALREADY_CLAIMED` and `TASK_NOT_READY` now include `error.recovery_hint: "refresh_manifest"`.

---

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

The POST body requires `{ name, kind, content, task_id? }`. Use `kind`, not `content_type`.
Supported `kind` values: `text`, `json`, `csv`, `markdown`.

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

For larger markdown content (tables, multi-paragraph sections), shell quoting inside `-d` can cause issues.
Use `--data-binary @file.json` instead:

```bash
cat > /tmp/artifact.json <<'EOF'
{
  "name": "aegis-pillars-summary.md",
  "kind": "markdown",
  "task_id": "task_coord_001",
  "content": "# Aegis Product Pillars\n\nFull content here..."
}
EOF

curl -s -X POST \
  -H "Authorization: Bearer pass_demo_001" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/artifact.json \
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

## Task Eligibility (as of Eligibility v1)

| Task | assignment_type | Who may claim |
|------|-----------------|---------------|
| task_coord_001 | delegation → delg_demo_001 | Agent A only (pass_demo_001) |
| task_coord_002 | collar → collar_research_001 | Agent B only (pass_demo_002, default_collar_id=collar_research_001) |

Agent A sees task_coord_001 in `task_summary.assigned_to_me` and task_coord_002 in `task_summary.not_eligible`.
Agent B sees task_coord_002 in `task_summary.eligible` and task_coord_001 in `task_summary.not_eligible`.

## Developer Verification (run before handing to agents)

```bash
# Verify Agent A manifest: assigned_to_me has task_coord_001, not_eligible has task_coord_002
curl -s -H "Authorization: Bearer pass_demo_001" \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001/manifest \
  | jq '{assigned_to_me: [.data.task_summary.assigned_to_me[].task_id], not_eligible: [.data.task_summary.not_eligible[].task_id]}'
# Expected: {"assigned_to_me":["task_coord_001"],"not_eligible":["task_coord_002"]}

# Verify Agent B manifest: eligible has task_coord_002, not_eligible has task_coord_001
curl -s -H "Authorization: Bearer pass_demo_002" \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001/manifest \
  | jq '{eligible: [.data.task_summary.eligible[].task_id], not_eligible: [.data.task_summary.not_eligible[].task_id]}'
# Expected: {"eligible":["task_coord_002"],"not_eligible":["task_coord_001"]}
```

If both return expected bucket assignments, eligibility is working correctly.

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

## Short System Prompt (Manifest + Eligibility Version)

These prompts do not include explicit task IDs. The agent reads the manifest, finds its
task via the eligibility buckets, and proceeds. This is the intended production flow.

### Manifest curl (verify before handing to agents)

```bash
# Agent A: should see task in assigned_to_me
curl -s -H "Authorization: Bearer pass_demo_001" \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001/manifest \
  | jq '{assigned_to_me: [.data.task_summary.assigned_to_me[].task_id], next_actions: .data.next_actions}'

# Agent B: should see task in eligible
curl -s -H "Authorization: Bearer pass_demo_002" \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001/manifest \
  | jq '{eligible: [.data.task_summary.eligible[].task_id], next_actions: .data.next_actions}'
```

### Agent A — short prompt

```
You are Agent A in an Aegis workspace coordination trial.
Bearer token: pass_demo_001 · API: http://localhost:4000
All requests: Authorization: Bearer pass_demo_001
POST/PATCH also need: Content-Type: application/json

1. GET /api/agent/v1/workspaces/ws_coord_trial_001/manifest
   Read task_summary carefully. Your task will be in assigned_to_me (pre-assigned to you).
   If assigned_to_me is empty, check eligible, then open. Follow next_actions.

2. Claim the task from assigned_to_me.
   PATCH .../tasks/{task_id}  {"action":"claim"}
   Use the task_id from the manifest, not a hardcoded value.

3. Read the task description from the manifest to understand what to write.
   Write 2-3 sentences each on: AegisID, Delegation & Collars, Aegis Rails, Aegis Guard, Audit Trail.

4. Create a markdown artifact named "aegis-pillars-summary.md" linked to your task_id.
   POST .../artifacts  {"name":"aegis-pillars-summary.md","kind":"markdown","task_id":"{task_id}","content":"<your content>"}

5. Complete the task.
   PATCH .../tasks/{task_id}  {"action":"complete"}

Report: artifact_id and final task status. Execute all steps sequentially.
```

### Agent B — short prompt

```
You are Agent B in an Aegis workspace coordination trial.
Bearer token: pass_demo_002 · API: http://localhost:4000
All requests: Authorization: Bearer pass_demo_002
POST/PATCH also need: Content-Type: application/json

1. GET /api/agent/v1/workspaces/ws_coord_trial_001/manifest
   Read task_summary. Your task will be in eligible (your collar qualifies for it).
   If eligible is empty, check open. Check recently_completed to see if Agent A has finished.
   If Agent A's task is not yet in recently_completed, stop and report.

2. Claim the task from eligible.
   PATCH .../tasks/{task_id}  {"action":"claim"}
   Use the task_id from the manifest, not a hardcoded value.

3. Find "aegis-pillars-summary.md" in manifest.artifacts. Then read its content.
   GET .../artifacts/{artifact_id}

4. Identify the single most important Aegis capability. Write a 3-bullet argument for why it matters.

5. Create a markdown artifact named "aegis-pillars-review.md" linked to your task_id.
   POST .../artifacts  {"name":"aegis-pillars-review.md","kind":"markdown","task_id":"{task_id}","content":"<your content>"}

6. Complete the task.
   PATCH .../tasks/{task_id}  {"action":"complete"}

Report: chosen pillar, 3 arguments, artifact_id, final task_counts. Execute all steps sequentially.
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

---

## Trial 2: Collar-Routing Trial

This trial proves that different agents, carrying different collars, are routed to different tasks.
Agent A carries `collar_research_001` and sees `task_coord_001` as eligible.
Agent B carries `collar_review_001` and sees `task_coord_002` as eligible (blocked until Task 1 completes).
Task 3 (`task_coord_003`) is open — either agent may claim it.

### Agent Identities (Collar Routing Trial)

| Agent   | Bearer Token   | Delegation ID        | Collar              |
|---------|----------------|----------------------|---------------------|
| Agent A | pass_demo_001  | delg_demo_001        | collar_research_001 |
| Agent B | pass_demo_002  | delg_demo_restricted | collar_review_001   |

### Expected Manifest Behavior

| Task            | Agent A (research)     | Agent B (review)            |
|-----------------|------------------------|-----------------------------|
| task_coord_001  | eligible / ready       | not_eligible                |
| task_coord_002  | not_eligible           | eligible / blocked          |
| task_coord_003  | open / ready           | open / ready                |

### Developer Verification (collar routing)

```bash
# Agent A: task_coord_001 eligible/ready, task_coord_002 not_eligible
curl -s -H "Authorization: Bearer pass_demo_001" \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001/manifest \
  | jq '[.data.recommended_work_queue[] | {task_id, eligibility, readiness, recommended_action}]'
# Expected: task_coord_001 eligible/ready/claim, task_coord_002 not_eligible/none, task_coord_003 open/ready/claim

# Agent B: task_coord_002 eligible/blocked, task_coord_001 not_eligible
curl -s -H "Authorization: Bearer pass_demo_002" \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001/manifest \
  | jq '[.data.recommended_work_queue[] | {task_id, eligibility, readiness, recommended_action}]'
# Expected: task_coord_001 not_eligible/none, task_coord_002 eligible/blocked/wait, task_coord_003 open/ready/claim

# Agent A tries to claim task_coord_002 → 403 TASK_NOT_ELIGIBLE
curl -s -X PATCH -H "Authorization: Bearer pass_demo_001" \
  -H "Content-Type: application/json" -d '{"action":"claim"}' \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001/tasks/task_coord_002 | jq '{code: .error.code}'

# Agent B tries to claim task_coord_001 → 403 TASK_NOT_ELIGIBLE
curl -s -X PATCH -H "Authorization: Bearer pass_demo_002" \
  -H "Content-Type: application/json" -d '{"action":"claim"}' \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001/tasks/task_coord_001 | jq '{code: .error.code}'

# Agent B tries to claim task_coord_002 before task_coord_001 is done → 409 TASK_NOT_READY
curl -s -X PATCH -H "Authorization: Bearer pass_demo_002" \
  -H "Content-Type: application/json" -d '{"action":"claim"}' \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001/tasks/task_coord_002 | jq '{code: .error.code, blockers: .blocker_reasons}'
```

### Collar-Routing Checklist

1. [ ] Agent A manifest shows `task_coord_001` with `eligibility: "eligible"`, `readiness: "ready"`.
2. [ ] Agent A manifest shows `task_coord_002` with `eligibility: "not_eligible"`, `blocker_reasons.not_eligible_reason` containing `collar_review_001`.
3. [ ] Agent B manifest shows `task_coord_002` with `eligibility: "eligible"`, `readiness: "blocked"`.
4. [ ] Agent B manifest shows `task_coord_001` with `eligibility: "not_eligible"`, `blocker_reasons.not_eligible_reason` containing `collar_research_001`.
5. [ ] Agent A claiming `task_coord_002` returns `403 TASK_NOT_ELIGIBLE`.
6. [ ] Agent B claiming `task_coord_001` returns `403 TASK_NOT_ELIGIBLE`.
7. [ ] Agent B claiming `task_coord_002` before Task 1 is complete returns `409 TASK_NOT_READY` with `blocker_reasons`.
8. [ ] After Agent A completes `task_coord_001` and creates `aegis-pillars-summary.md`, Agent B's manifest shows `task_coord_002` as `eligible / ready`.
9. [ ] Agent B can then claim and complete `task_coord_002`.
10. [ ] Either agent can claim `task_coord_003` (open, no collar requirement).

---

---

## Trial 3: Concurrent Real-Agent Trial

Two live Claude agents run simultaneously. Agent A (research collar) and Agent B (review collar) each receive their prompt at roughly the same time. They self-route using the manifest, avoid duplicate work, and hand off through an artifact — without being told which task to claim.

### Setup

```bash
npm run seed:demo          # from repo root — resets to clean state
cd apps/api && npm run dev # server at http://localhost:4000

# Pre-flight: verify collar routing before handing to agents
curl -s -H "Authorization: Bearer pass_demo_001" \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001/manifest \
  | jq '[.data.recommended_work_queue[] | {task_id,eligibility,readiness,recommended_action}]'
# Expected: task_coord_001 eligible/ready/claim, task_coord_002 not_eligible/none, task_coord_003 open/ready/claim

curl -s -H "Authorization: Bearer pass_demo_002" \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001/manifest \
  | jq '[.data.recommended_work_queue[] | {task_id,eligibility,readiness,recommended_action}]'
# Expected: task_coord_001 not_eligible/none, task_coord_002 eligible/blocked/wait, task_coord_003 open/ready/claim

# Confirm workflow_rules has 10 entries (two 409-recovery rules added in Trial 3 prep)
curl -s -H "Authorization: Bearer pass_demo_001" \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001/manifest \
  | jq '.data.workflow_rules | length'
# Expected: 10
```

Open two separate Claude sessions. Start both prompts within ~30 seconds of each other.

---

### Agent A Prompt — Research Agent (concurrent)

```
You are Research Agent in an Aegis workspace coordination trial.
Bearer token: pass_demo_001 · API: http://localhost:4000
Authorization: Bearer pass_demo_001 on every request.
POST/PATCH also need: Content-Type: application/json

1. GET /api/agent/v1/workspaces/ws_coord_trial_001/manifest
   Read recommended_work_queue. Find the task with eligibility="eligible" and readiness="ready".
   That is your primary task. Note its task_id and read its description carefully.
   If no eligible task is ready, fall back to eligibility="open" with readiness="ready".
   Pick the highest-priority ready task.

2. PATCH /api/agent/v1/workspaces/ws_coord_trial_001/tasks/{task_id}
   Body: {"action":"claim"}
   On 409 TASK_ALREADY_CLAIMED: refresh manifest (repeat step 1), pick the next ready task.
   On 409 TASK_NOT_READY: stop and report — your eligible task is still blocked.
   On 200: proceed.

3. Do the work described in the task.
   For task_coord_001 (research): write 2–3 sentences each on:
   AegisID · Delegation & Collars · Aegis Rails · Aegis Guard · Audit Trail.

4. Create a markdown artifact. Use the artifact name stated in the task description.
   POST /api/agent/v1/workspaces/ws_coord_trial_001/artifacts
   Body: {"name":"<name from task>","kind":"markdown","task_id":"{task_id}","content":"<your content>"}
   Note the artifact_id from the response.

5. PATCH /api/agent/v1/workspaces/ws_coord_trial_001/tasks/{task_id}
   Body: {"action":"complete"}
   Only complete the task you claimed.

6. Report: task_id claimed, artifact_id created, final task status.
Execute all steps sequentially. Do not ask for clarification.
```

---

### Agent B Prompt — Review Agent (concurrent, with polling)

```
You are Review Agent in an Aegis workspace coordination trial.
Bearer token: pass_demo_002 · API: http://localhost:4000
Authorization: Bearer pass_demo_002 on every request.
POST/PATCH also need: Content-Type: application/json

Your collar qualifies you for a review task. That task may be blocked at the start —
another agent must finish work before you can proceed. Follow the steps below.

1. GET /api/agent/v1/workspaces/ws_coord_trial_001/manifest
   Read recommended_work_queue. Identify:
   - Your primary task: eligibility="eligible" (your collar qualifies for it).
   - Any fallback tasks: eligibility="open", readiness="ready".

2. Check your primary task's readiness:
   - readiness="ready": claim it now (step 3).
   - readiness="blocked": your primary task is waiting on another agent.
     Check for an open task with readiness="ready". If one exists, claim and complete it
     (steps 3–7), then repeat from step 1 to check if your primary task has unblocked.
     If no open task is available either, wait 60 seconds and repeat step 1.
     Do not attempt to claim a blocked task — the manifest shows recommended_action="wait".

3. PATCH /api/agent/v1/workspaces/ws_coord_trial_001/tasks/{task_id}
   Body: {"action":"claim"}
   On 409 TASK_ALREADY_CLAIMED: refresh manifest (step 1), pick the next ready task.
   On 409 TASK_NOT_READY: your primary task is still blocked — repeat from step 2.
   On 200: proceed.

4. If you claimed a review task: discover the artifact it depends on.
   GET /api/agent/v1/workspaces/ws_coord_trial_001/artifacts
   Find the artifact named in the task description. Note its artifact_id.
   GET /api/agent/v1/workspaces/ws_coord_trial_001/artifacts/{artifact_id}
   Read the full content.

5. Do the work described in the task.
   For task_coord_002 (review): identify the most important Aegis capability
   from the artifact you just read. Write a 3-bullet argument for why it matters.

6. Create a markdown artifact. Use the artifact name stated in the task description.
   POST /api/agent/v1/workspaces/ws_coord_trial_001/artifacts
   Body: {"name":"<name from task>","kind":"markdown","task_id":"{task_id}","content":"<your content>"}
   Note the artifact_id.

7. PATCH /api/agent/v1/workspaces/ws_coord_trial_001/tasks/{task_id}
   Body: {"action":"complete"}
   Only complete the task you claimed.

8. Report: all task_ids claimed, artifact_ids created, final task_counts.
Execute all steps. Do not ask for clarification. If your primary task remains blocked
after completing an interim task, re-run step 1 until it unblocks.
```

---

### Optional: Open-Task Contention Prompt

Use this to stress-test 409 recovery when two agents race for `task_coord_003`.
Run the same prompt simultaneously in two sessions — one with `pass_demo_001`, one with `pass_demo_002`.
One agent wins the claim; the other hits 409 TASK_ALREADY_CLAIMED and must recover.

Most naturally occurs during the concurrent trial when Agent B is waiting for task_coord_002
to unblock and both agents consider task_coord_003 at the same time.

```
You are a workspace agent in an Aegis coordination trial.
Bearer token: <YOUR_TOKEN> · API: http://localhost:4000
Authorization: Bearer <YOUR_TOKEN> on every request.
POST/PATCH also need: Content-Type: application/json

1. GET /api/agent/v1/workspaces/ws_coord_trial_001/manifest
   Read recommended_work_queue. Find any task with readiness="ready" and
   eligibility="eligible" OR eligibility="open". Pick the highest-priority one.

2. PATCH /api/agent/v1/workspaces/ws_coord_trial_001/tasks/{task_id}
   Body: {"action":"claim"}
   On 200: proceed to step 3.
   On 409 TASK_ALREADY_CLAIMED: refresh manifest (step 1), pick the next highest-priority ready task.
   On 409 TASK_NOT_READY: skip this task, pick the next ready task from the manifest.

3. Do the work described in the task. One paragraph summary is enough.

4. POST /api/agent/v1/workspaces/ws_coord_trial_001/artifacts
   Body: {"name":"<task-id>-output.md","kind":"markdown","task_id":"{task_id}","content":"<your content>"}

5. PATCH /api/agent/v1/workspaces/ws_coord_trial_001/tasks/{task_id}
   Body: {"action":"complete"}

6. Report: task_id, result of every claim attempt (including any 409 errors), final task status.
Execute all steps. Do not ask for clarification.
```

---

### Expected Timeline

| Time | Agent A | Agent B |
|---|---|---|
| T+0s | GET manifest → task_coord_001 eligible/ready | GET manifest → task_coord_002 eligible/blocked |
| T+10s | Claims task_coord_001 → 200 | Sees task_coord_003 open/ready → claims it |
| T+15s | (if contention on task_coord_003) | May get 409 TASK_ALREADY_CLAIMED → refreshes, waits |
| T+30s–2min | Does research, drafts content | Completes task_coord_003; re-polls manifest |
| T+2min | POSTs aegis-pillars-summary.md artifact | Polls manifest → task_coord_002 still blocked |
| T+2.5min | COMPLETEs task_coord_001 | Polls manifest → task_coord_002 now ready |
| T+3min | Done | Claims task_coord_002 → 200 |
| T+4–5min | — | Reads artifact, drafts review, posts artifact, completes |
| T+5min | — | Final counts: {open:0, in_progress:0, completed:3} |

---

### Verification Curls

```bash
# Current task status snapshot (run at any point during trial)
curl -s -H "Authorization: Bearer pass_demo_001" \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001/tasks \
  | jq '[.data[] | {task_id, status, assigned_delegation_id}]'

# Artifacts created so far
curl -s -H "Authorization: Bearer pass_demo_001" \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001/artifacts \
  | jq '[.data[] | {artifact_id, name, created_by_delegation_id}]'

# Final workspace counts
curl -s -H "Authorization: Bearer pass_demo_001" \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001 \
  | jq '.data.task_counts'
# Expected at end: {"open":0,"in_progress":0,"completed":3}

# Read Agent A's artifact (replace <artifact_id> from artifacts list above)
curl -s -H "Authorization: Bearer pass_demo_002" \
  http://localhost:4000/api/agent/v1/workspaces/ws_coord_trial_001/artifacts/<artifact_id> \
  | jq '.data.content'
```

---

### What to Observe (Checklist)

1. [ ] Agent A manifest shows task_coord_001 eligible/ready and task_coord_002 not_eligible — collar routing works.
2. [ ] Agent B manifest shows task_coord_002 eligible/blocked and task_coord_001 not_eligible.
3. [ ] Agent A claims task_coord_001. Agent B does NOT attempt task_coord_001 (manifest shows not_eligible).
4. [ ] Agent B claims task_coord_003 or waits while task_coord_002 is blocked.
5. [ ] After Agent A posts aegis-pillars-summary.md and completes task_coord_001, Agent B's next manifest GET shows task_coord_002 as eligible/ready.
6. [ ] Agent B claims task_coord_002 after readiness unblocks.
7. [ ] Agent B's review artifact quotes or references specific content from Agent A's artifact (proves actual read, not fabrication).
8. [ ] No agent attempts to complete a task it does not own (would get 403 TASK_NOT_ASSIGNED).
9. [ ] If task_coord_003 contention occurs: the losing agent reports 409 TASK_ALREADY_CLAIMED and recovers.
10. [ ] Final task_counts: {open:0, in_progress:0, completed:3}.

---

### Failure Modes

| Failure | Signal | Recovery |
|---|---|---|
| Agent B tries to claim task_coord_002 while blocked | 409 TASK_NOT_READY + blocker_reasons | workflow_rules string #9 tells agent to re-poll manifest |
| Both agents race for task_coord_003 | One gets 409 TASK_ALREADY_CLAIMED | workflow_rules string #8 tells agent to refresh and pick next |
| Agent A misreads manifest and tries task_coord_002 | 403 TASK_NOT_ELIGIBLE (collar mismatch) | Manifest already marks it not_eligible; agent should skip |
| Agent B tries to complete a task it didn't claim | 403 TASK_NOT_ASSIGNED | Task completion is delegation-scoped; not a coordination failure |
| Agent B polls indefinitely because Agent A stalls | No API error | Intervene manually; check Agent A's session state |
| Both agents claim task_coord_001 simultaneously | Collar routing fires first — Agent B gets 403 TASK_NOT_ELIGIBLE before any race logic | Not a real race condition; collar enforcement prevents it |
