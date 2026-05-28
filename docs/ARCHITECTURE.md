# ARCHITECTURE.md

## Purpose

This document defines the system architecture for Aegis.

Aegis is the trust and control layer for autonomous AI agents. It does not create agents. It lets users attach identity, permissions, restrictions, approvals, protected sessions, receipts, and reputation to agents built anywhere.

The architecture should preserve one core idea:

> Outside agents plan. Aegis controls sensitive action.

## Core Architecture

Aegis has eight major components:

1. AegisID
2. Aegis Pass
3. Collars
4. Protected Sessions
5. Sensitive Action Detector
6. Policy Engine
7. Aegis Runners
8. Receipts and Reputation

High-level flow:

Outside Agent  
→ Aegis Pass  
→ Protected Session or Tool Gateway  
→ Sensitive Action Detector  
→ Policy Engine  
→ Approval Inbox or Aegis Runner  
→ Receipt  
→ Reputation Signal

## Design Principles

### 1. Aegis is not an agent builder

Users should be able to create agents on any platform, including ChatGPT, Claude, Gemini, OpenClaw-style browsers, custom MCP agents, or future agent platforms.

Aegis attaches trust and control to those agents.

### 2. Do not give agents raw secrets

Agents should not directly receive:

- passwords
- credit card numbers
- full identity documents
- unrestricted OAuth tokens
- unrestricted browser sessions
- private files
- sensitive personal data

Instead, agents should receive an Aegis Pass that lets them request controlled capabilities.

### 3. Control the action boundary, not every thought

Aegis should not monitor every token, click, scroll, or page view by default.

Agents should be free to browse, search, compare, research, and draft.

Aegis should intervene when the agent tries to perform sensitive actions, such as:

- login
- payment
- purchase
- subscription
- posting
- messaging
- email sending
- file upload
- form submission
- identity disclosure
- account setting changes
- irreversible actions

Core line:

> Agents can browse. Aegis decides when they can commit.

### 4. Enforcement must happen outside the model

Prompts are not enough.

Aegis should enforce restrictions through:

- controlled browser sessions
- tool gateways
- OAuth/token controls
- credential vaulting
- temporary Aegis Runners
- approval flows
- signed collars
- revocation checks

The model can think whatever it wants. Aegis controls what it can do.

## Component 1: AegisID

AegisID is the durable identity and reputation layer.

AegisID may exist for:

- users
- agent sessions
- businesses
- websites
- APIs

### User AegisID

Represents a real user or organization.

Can hold reusable verified claims:

- verified human
- verified student
- verified employee
- verified adult
- verified guardian
- verified business owner

These claims should be disclosed minimally.

Example:

The agent should be able to prove “verified student” without exposing a full student ID, transcript, or unrelated identity information.

### Agent Session AegisID

Represents a specific active agent session.

It should include:

- user backing
- active collar
- allowed capabilities
- expiration
- status
- current protected session if any

Agent sessions are temporary.

The durable trust history should primarily belong to the user’s AegisID, not the disposable agent.

### Business AegisID

Represents a verified business.

Can include:

- verified legal entity
- verified domain
- agent policy
- dispute history
- incident reports
- trust tier

### Website AegisID

Represents a verified domain or website.

Can include:

- domain ownership
- associated business
- agent policy URL
- known risk reports
- prompt injection reports

## Component 2: Aegis Pass

An Aegis Pass is what a user gives to an outside agent.

It should not contain raw credentials.

It should allow the agent to request:

- protected browser sessions
- limited capabilities
- verified identity claims
- website or business verification
- approval for sensitive actions
- temporary execution through Aegis Runners

The Aegis Pass should be:

- scoped
- revocable
- expiring
- tied to a user
- tied to one or more collars
- usable by outside agents

Example Aegis Pass shape:

{
  "id": "pass_123",
  "user_id": "user_123",
  "agent_name": "Shopping Agent",
  "allowed_collars": ["shopping"],
  "default_collar": "shopping",
  "status": "active",
  "expires_at": "2026-04-27T00:00:00Z"
}

The Aegis Pass is not the same as a collar.

The pass lets the agent request access.

The collar defines what access means.

## Component 3: Collars

A collar is a permission and restriction bundle attached to an agent session.

It defines:

- allowed actions
- blocked actions
- approval-required actions
- available verified claims
- allowed counterparties
- expiration
- risk thresholds
- receipt requirements

A collar should eventually be represented as a signed, revocable permission object.

For MVP, it can start as a server-side policy object.

Example Shopping Collar:

{
  "type": "shopping",
  "allowed_actions": [
    "browse",
    "search",
    "compare",
    "read_reviews",
    "add_to_cart"
  ],
  "approval_required": [
    "login",
    "purchase",
    "payment",
    "share_email",
    "share_phone",
    "create_account",
    "submit_shipping_address"
  ],
  "blocked_actions": [
    "save_payment_method",
    "buy_subscription",
    "upload_government_id",
    "share_sensitive_identity"
  ]
}

Core line:

> The collar is not a prompt. It is an enforceable policy boundary.

## Component 4: Protected Sessions

Protected Sessions are controlled browser sessions that agents can use when they need the web.

The outside agent should be able to request a session through:

- MCP tool
- API endpoint
- local bridge
- future agent platform integration

The protected session should be:

- isolated from the user’s normal browser
- short-lived
- collar-bound
- revocable
- headless by default
- visible on demand
- monitored for sensitive action boundaries

Recommended technical direction:

- Playwright-controlled Chromium
- isolated browser context
- separate profile from the user’s normal browser
- event hooks for navigation, clicks, forms, fields, downloads, uploads, and network requests

A protected session should never expose the user’s normal browser profile directly to the agent.

## Component 5: Sensitive Action Detector

The Sensitive Action Detector watches for moments where browsing turns into authority.

Initial detection should be rule-based.

Signals:

- URL patterns
- button text
- input types
- form labels
- nearby text
- network requests
- file uploads
- outgoing form data
- known sensitive page categories

Sensitive actions include:

- login
- payment
- purchase
- subscription
- public post
- comment
- DM
- email send
- file upload
- form submission
- identity disclosure
- account settings change
- OAuth authorization
- delete/cancel action

Example detection rules:

- input type is password
- autocomplete is cc-number
- URL contains checkout
- button text contains Place Order
- button text contains Post
- button text contains Send
- file upload input appears
- form contains address and card fields
- network request includes payment endpoint
- page contains subscription or recurring billing language

Advanced AI classification can be added later, but MVP should begin with simple deterministic rules.

## Component 6: Policy Engine

The Policy Engine decides whether an action should be allowed, blocked, or escalated.

Inputs:

- active collar
- requested action
- current domain
- session status
- website or business trust status
- risk level
- available verified claims
- user settings
- approval history
- expiration status

Outputs:

- allow
- block
- approval_required
- runner_required
- revoke_session
- log_only

Example policy decision:

{
  "decision": "approval_required",
  "reason": "Shopping Collar requires approval before purchase.",
  "action_type": "purchase",
  "risk_level": "high"
}

Example policy logic:

- If action is in blocked_actions, block.
- If action is in approval_required, pause and request approval.
- If action is in allowed_actions, allow.
- If domain is unverified and action is sensitive, require approval or block.
- If session expired, block.
- If collar revoked, block.
- If action is ambiguous, require approval.

The policy engine should be boring, explicit, and auditable.

## Component 7: Approval Inbox

The Approval Inbox is the user-facing control surface for sensitive actions.

It should show approval cards such as:

Your Shopping Agent wants to purchase running shoes for $89.99.

Merchant: Nike  
Website: nike.com  
Collar: Shopping  
Reason: Purchases require approval.

Approve / Deny / View Session

The approval inbox should support:

- approve once
- deny once
- block site
- pause session
- revoke pass
- view session
- view receipt after completion

Approval should only be requested when risk crosses a meaningful threshold.

Aegis should not create constant approval spam.

## Component 8: Aegis Runners

Aegis Runners are temporary executors that complete sensitive actions without exposing raw secrets to the outside agent.

A Runner may:

- log into a site
- fill payment information
- disclose a verified claim
- publish approved content
- send approved email
- upload approved file
- submit an approved form

Runners should be:

- short-lived
- narrowly scoped
- collar-bound
- logged
- terminated after completion

Example Runner task:

{
  "runner_task": "complete_approved_payment",
  "session_id": "sess_123",
  "domain": "nike.com",
  "amount_max": 89.99,
  "expires_in_seconds": 120,
  "can_use_payment": true,
  "can_change_shipping": false,
  "can_buy_subscription": false
}

The outside agent should receive the result, not the raw credential.

Core line:

> Agents request outcomes. Aegis controls authority.

### Input Realism

Input realism is the runtime layer between pointer focus and field-value verification in a sensitive handoff.

When Antigen fills a credential, OTP, profile value, or payment field, value insertion should feel intentional and legible — not instantaneous or mechanical. This is an execution quality concern for the user, not an attempt to defeat bot detection or impersonate a human.

Sequencing within a sensitive-field fill:

1. Pointer moves to the field (pointer realism — calibrated trace)
2. Field receives focus (click via CDP)
3. Value is inserted at a controlled, field-kind-aware cadence (input realism)
4. Antigen verifies the field accepted input
5. Lifecycle status (`executing_at`, `filled_at`) is recorded; control returns to the agent

Input realism must not:

- log raw characters or reconstructable partial values
- produce per-character diagnostic payloads
- expose the raw secret to the external agent at any point
- bypass approval gates or alter the existing lifecycle state machine

Field-kind profiles (`secret_password`, `username_email`, `otp_code`, `profile_text`, `payment_card`) govern per-character timing. These are starting points, not final constants.

See `docs/TYPING_INPUT_REALISM.md` for goals, non-goals, input classes, safety invariants, diagnostics spec, failure modes, phased implementation plan, and acceptance criteria.

## Component 9: Receipts

Receipts are records of trust-relevant events.

Receipts create accountability without storing unnecessary private detail.

A receipt should be created when:

- sensitive action is requested
- user approves or denies
- Aegis blocks an action
- Aegis Runner completes sensitive execution
- prompt injection or suspicious behavior is reported
- a dispute occurs

Example receipt:

{
  "id": "rec_123",
  "session_id": "sess_456",
  "collar_type": "shopping",
  "action_type": "purchase",
  "decision": "approved_by_user",
  "domain": "nike.com",
  "outcome": "completed",
  "created_at": "2026-04-26T01:05:00Z"
}

Receipts should avoid storing:

- raw passwords
- full card numbers
- full identity documents
- unnecessary private content
- full browsing history
- full LLM conversation logs by default

Receipts should store enough to prove:

- what was requested
- what policy applied
- who approved or denied
- what counterparty was involved
- what outcome occurred

## Component 10: Reputation

Reputation is built from receipts.

Aegis reputation should not be a universal social credit score.

It should be:

- category-specific
- explainable
- privacy-preserving
- based on outcomes
- decayed over time
- tied to verified delegation

Reputation categories may include:

- shopping trust
- travel trust
- email trust
- social posting trust
- identity disclosure trust
- business trust
- website trust
- agent platform trust

The durable reputation should mostly attach to AegisID, not one disposable agent instance.

Example trust claim:

Agents backed by this AegisID have completed 18 shopping interactions with verified businesses and no disputes.

## Component 11: Multi-Agent Workspaces

Workspaces are shared, permissioned coordination contexts for multiple delegated agents working on a common goal.

### Structure

- `AegisWorkspace` — named context with an owner, a workspace collar, and a list of participant delegations.
- `WorkspaceTask` — claimable unit of work; status ladder: `open → in_progress → completed / cancelled`.
- `WorkspaceArtifact` — text output produced by an agent within a workspace (max 50 KB); kinds: `text`, `json`, `csv`, `markdown`.
- `WorkspaceAuditEvent` — lightweight record of `task_claimed`, `task_completed`, and `artifact_created` events.

### Access model (v1)

Access to any workspace operation requires three guards, checked in order:

1. **Workspace guard** — workspace exists and `status === "active"`.
2. **Collar liveness guard** — `workspace.collar_id` references an active collar.
3. **Participant guard** — calling delegation is in `participant_delegation_ids`.

### Effective permissions (v1)

Per-operation enforcement uses the **intersection** of two collars — the stricter limit wins:

- **Workspace collar** — set by the workspace owner; governs what all participants may do in this workspace.
- **Delegation collar** — `delegation.default_collar_id`; governs what the specific agent is permitted to do globally.

Seven workspace-scoped `ActionType` values: `workspace_read`, `workspace_task_list`, `workspace_task_claim`, `workspace_task_complete`, `workspace_artifact_create`, `workspace_artifact_list`, `workspace_artifact_read`.

Semantics follow existing collar rules: absent from both `allowed_actions` and `approval_required_actions` = hard block (strict opt-in). `approval_required` from either collar returns `WORKSPACE_PERMISSION_REQUIRES_APPROVAL` (403) — no workspace CRUD approval flow exists yet.

### Invariants

- Non-participant denied before permission evaluation.
- Archived workspace denied before permission evaluation.
- Inactive workspace collar denied before operation permission evaluation.
- Content is never returned in POST artifact responses.
- No workspace operations are exposed via MCP tools in v1.
- No Supabase persistence, no UI, no invite flow in v1.

### Implementation

- Domain logic: `apps/api/src/lib/workspaceDomain.ts` — `requireWorkspaceAccess`, `checkWorkspacePermission`, `emitWorkspaceAudit`
- Agent API endpoints: `apps/api/src/routes/agent-api.ts` (six handlers under `/api/agent/v1/workspaces/`)
- User-facing endpoints: `apps/api/src/routes/workspaces.ts` — `POST /api/workspaces`, `GET /api/workspaces`
- Tests: `apps/api/src/__tests__/workspace-coordination.test.ts` — 35 passing tests

## Main System Flows

### Flow 1: Agent starts protected web session

1. User creates Aegis Pass.
2. User attaches collar.
3. Outside agent receives Aegis Pass.
4. Agent requests protected browser session.
5. Aegis validates pass.
6. Aegis assigns collar.
7. Aegis launches isolated browser context.
8. Agent uses browser through Aegis tools.
9. Aegis monitors for sensitive boundaries.

### Flow 2: Agent attempts sensitive action

1. Agent browses normally.
2. Agent reaches sensitive action.
3. Detector identifies action type.
4. Policy Engine checks collar.
5. Aegis returns allow, block, or approval_required.
6. If approval is required, session pauses.
7. User approves or denies.
8. Aegis Runner executes approved action if needed.
9. Receipt is created.
10. Reputation signal updates.

### Flow 3: Aegis Runner performs action

1. Policy Engine determines runner_required.
2. Runner receives narrow task.
3. Runner receives only the minimum authority needed.
4. Runner performs task.
5. Runner terminates.
6. Agent receives result.
7. Receipt is created.

### Flow 4: Business or website verification

Future flow:

1. Business creates Aegis account.
2. Business verifies legal entity.
3. Business verifies domain ownership.
4. Business publishes agent policy.
5. Aegis issues Business AegisID.
6. Agents and users can check business trust before sensitive actions.

## Suggested MVP Tech Stack

This is not final, but a reasonable starting direction.

Frontend:

- React
- TypeScript
- Tailwind
- Vite or Next.js

Backend:

- Node.js
- TypeScript
- Express or Fastify
- PostgreSQL or Supabase

Browser control:

- Playwright
- Chromium
- isolated browser contexts
- headless mode with optional visible mode

Realtime:

- WebSockets or server-sent events for session updates and approvals

Auth:

- simple user auth for MVP
- later OAuth/passkeys

Storage:

- users
- aegis passes
- collars
- sessions
- approvals
- receipts
- reputation events

## Suggested Directory Structure

aegis/
  apps/
    web/
      src/
        components/
        pages/
        lib/
    api/
      src/
        routes/
        services/
        policies/
        browser/
        runners/
        receipts/
  docs/
    README.md
    AGENT.md
    MVP_SCOPE.md
    ARCHITECTURE.md
    COLLARS.md
    AEGISID.md
    REPUTATION.md
    DEMO_SCRIPT.md

## MVP Services

### Pass Service

Responsible for:

- creating Aegis Passes
- revoking passes
- checking expiration
- mapping pass to user and collars

### Collar Service

Responsible for:

- storing collar presets
- resolving active collar
- exposing allowed, blocked, and approval-required actions

### Browser Session Service

Responsible for:

- launching Playwright browser contexts
- managing session lifecycle
- exposing browser tools to agents
- tracking current URL and session state

### Detection Service

Responsible for:

- detecting sensitive action boundaries
- classifying action types
- preparing context for policy evaluation

### Policy Service

Responsible for:

- evaluating action against collar
- checking domain trust
- returning allow, block, approval_required, or runner_required

### Approval Service

Responsible for:

- creating approval requests
- updating approval status
- pausing and resuming sessions

### Runner Service

Responsible for:

- executing approved sensitive actions
- limiting access to secrets
- terminating after task completion

### Receipt Service

Responsible for:

- creating receipts
- storing trust-relevant events
- feeding reputation system

### Reputation Service

Responsible for:

- aggregating receipt signals
- producing simple trust summaries
- avoiding overcollection

## Security Boundaries

Aegis should treat the outside agent as untrusted.

The outside agent may be:

- confused
- prompt-injected
- malicious
- over-permissioned
- using an unsafe model
- operating outside user intent

Therefore:

- do not expose raw credentials to the agent
- do not expose full identity documents to the agent
- do not expose full payment details to the agent
- do not let the agent use unrestricted browser sessions
- do not trust the agent’s description of an action without verifying context
- do not rely on prompts as enforcement

The trusted boundary should be Aegis-controlled tools, tokens, sessions, approvals, and receipts.

## Privacy Boundaries

Aegis should avoid becoming creepy.

Do not track everything by default.

Avoid storing:

- full browsing history
- full LLM chats
- raw credentials
- unnecessary screenshots
- private message contents
- full page contents
- raw identity documents when possible

Prefer storing:

- action category
- collar used
- decision
- counterparty domain
- approval status
- outcome
- timestamp
- receipt ID

Riskier actions may justify more detailed receipts, but the default should be minimal.

## Future Architecture

Future versions may include:

- real identity verification providers
- student and employee claim verification
- virtual cards
- OAuth integrations
- business AegisID
- website AegisID
- prompt injection reporting network
- family and guardian controls
- elder protection mode
- mobile approval app
- public trust badges
- agent platform integrations
- MCP gateway
- browser extension
- enterprise admin console

## Core Lines To Preserve

- Agents are disposable. Trust is not.
- Aegis is the collar you put on AI agents before letting them act for you.
- Do not give your agent your password. Give it an Aegis Pass.
- Agents can browse. Aegis decides when they can commit.
- Outside agents plan. Aegis executes sensitive steps.
- Aegis turns secrets into controlled capabilities.
- Aegis lets agents use your authority without possessing your secrets.
- Aegis reputation is a history of how safely your agents act under verified delegation.

