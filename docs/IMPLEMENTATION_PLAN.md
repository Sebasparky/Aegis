# IMPLEMENTATION_PLAN.md

## Purpose

This document turns the Aegis product thesis into a concrete build plan.

The goal is to avoid building the entire vision at once.

The first implementation should prove the core loop:

> An outside agent can request a protected browser session, browse freely, trigger a sensitive action boundary, get paused by Aegis, require approval, complete or block the action, and create a receipt.

Core line:

> Agents can browse. Aegis decides when they can commit.

## MVP Build Philosophy

Build the smallest system that proves Aegis is more than an idea.

Do not start with:

- full password manager
- real credit card handling
- real government ID verification
- universal business verification
- complete reputation graph
- agent marketplace
- family controls
- elder protection mode
- insurance
- enterprise admin console

Start with:

- Aegis Pass
- customizable collar
- protected browser session
- sensitive action detection
- policy decision
- approval inbox
- simulated Aegis Runner
- receipt log
- basic reputation event log

## Recommended Tech Stack

This is a practical starting stack.

Frontend:

- React
- TypeScript
- Tailwind
- Vite or Next.js

Backend:

- Node.js
- TypeScript
- Express or Fastify

Browser automation:

- Playwright
- Chromium
- isolated browser contexts

Database:

- PostgreSQL
- Supabase is acceptable for speed

Realtime:

- WebSockets or Server-Sent Events

Auth:

- simple email auth or mock auth for prototype
- later upgrade to real auth

Deployment:

- local-first for prototype
- cloud deployment later

## Repo Structure

Suggested structure:

aegis/
  apps/
    web/
      src/
        components/
        pages/
        lib/
        hooks/
        styles/
    api/
      src/
        routes/
        services/
        policies/
        browser/
        runners/
        receipts/
        reputation/
        db/
  docs/
    README.md
    AGENT.md
    PRODUCT_THESIS.md
    MVP_SCOPE.md
    ARCHITECTURE.md
    COLLARS.md
    AEGISID.md
    REPUTATION.md
    DEMO_SCRIPT.md
    IMPLEMENTATION_PLAN.md

## Milestone 0: Project Setup

Goal:

Create a basic monorepo or app structure with frontend, backend, and docs.

Deliverables:

- repo initialized
- docs folder created
- web app running
- api server running
- shared TypeScript types if needed
- basic environment config

Do not build product logic yet.

Success criteria:

- `npm run dev` starts frontend and backend
- user can open web UI
- backend health route works

Suggested routes:

- GET /health

Suggested UI:

- simple Aegis dashboard placeholder
- title
- short product tagline

## Milestone 1: Core Data Models

Goal:

Create the basic objects Aegis needs.

Required models:

- User
- AegisPass
- Collar
- ProtectedSession
- ApprovalRequest
- Receipt
- ReputationEvent

For prototype, these can start in memory or SQLite/Postgres.

Do not overbuild schema.

### User

Fields:

- id
- email
- created_at

### AegisPass

Fields:

- id
- user_id
- agent_name
- purpose
- default_collar_id
- status
- expires_at
- created_at

### Collar

Fields:

- id
- user_id
- name
- purpose
- allowed_actions
- approval_required_actions
- blocked_actions
- spending_limits
- counterparty_rules
- session_limits
- status
- created_at
- updated_at

### ProtectedSession

Fields:

- id
- user_id
- aegis_pass_id
- collar_id
- status
- mode
- current_url
- browser_context_id
- created_at
- expires_at

### ApprovalRequest

Fields:

- id
- session_id
- action_type
- risk_level
- domain
- summary
- reason
- status
- created_at
- resolved_at

### Receipt

Fields:

- id
- session_id
- collar_id
- action_type
- decision
- domain
- outcome
- created_at

### ReputationEvent

Fields:

- id
- entity_type
- entity_id
- event_type
- category
- session_id
- receipt_id
- severity
- created_at

Success criteria:

- can create and list collars
- can create and list Aegis Passes
- can create and list sessions
- can create and list approvals
- can create and list receipts

## Milestone 2: Collar Engine

Goal:

Build the customizable collar policy engine.

The collar engine should not be hardcoded to shopping.

It should evaluate generic action types.

Initial action types:

- browse
- search
- read
- compare
- draft
- add_to_cart
- login
- purchase
- payment
- subscription
- post_publicly
- comment
- direct_message
- send_email
- upload_file
- submit_form
- create_account
- share_email
- share_phone
- share_address
- identity_disclosure
- government_id_upload
- account_setting_change
- oauth_authorize

Policy decision function:

evaluateAction(input) returns:

- allow
- approval_required
- block
- runner_required

Inputs:

- collar
- action_type
- domain
- context
- session
- counterparty_trust_status

Example input:

{
  "collar_id": "collar_123",
  "action_type": "purchase",
  "domain": "nike.com",
  "context": {
    "amount": 89.99,
    "subscription": false
  }
}

Example output:

{
  "decision": "approval_required",
  "reason": "This collar requires approval before purchase.",
  "risk_level": "high"
}

Rules:

- if action is blocked, block
- if action requires approval, approval_required
- if action is allowed, allow
- if action is unknown and sensitive-looking, approval_required
- if session expired, block
- if collar revoked, block
- if unverified counterparty requests sensitive action, approval_required or block depending on collar

Success criteria:

- can evaluate allowed action
- can evaluate approval-required action
- can evaluate blocked action
- can explain decision
- can evaluate custom collar, not just template

## Milestone 3: Collar UI

Goal:

Create the user-facing collar editor.

The collar editor should support both simple and advanced configuration.

MVP UI sections:

- collar name
- purpose
- allowed actions
- approval-required actions
- blocked actions
- expiration
- spending limit
- counterparty requirement

The user should be able to:

- create custom collar
- edit collar
- view collar
- attach collar to Aegis Pass

Templates can exist, but they should be editable.

Example template:

Shopping-like starter collar:

Allowed:

- browse
- search
- compare
- read
- add_to_cart

Approval required:

- login
- purchase
- payment
- share_email
- share_phone
- submit_form

Blocked:

- subscription
- save_payment_method
- government_id_upload
- identity_disclosure

Success criteria:

- user can create a custom collar
- user can customize actions
- user can save collar
- user can see collar rules clearly
- user can attach collar to a pass

## Milestone 4: Aegis Pass

Goal:

Create an Aegis Pass that outside agents can use to request protected sessions.

For prototype, the pass can be a generated token.

Fields:

- pass_id
- token
- user_id
- default_collar_id
- agent_name
- purpose
- status
- expires_at

Routes:

- POST /passes
- GET /passes
- GET /passes/:id
- POST /passes/:id/revoke

Agent-facing route:

- POST /agent/create-session

Request:

{
  "agent_pass_token": "pass_token_123",
  "purpose": "Find running shoes under $100",
  "requested_collar": "shopping"
}

Response:

{
  "session_id": "sess_123",
  "collar_id": "collar_123",
  "status": "active"
}

Success criteria:

- user can create pass
- pass can be revoked
- outside agent can use pass to request session
- expired or revoked pass is rejected
- session is created with correct collar

## Milestone 5: Protected Browser Session

Goal:

Launch a Playwright-controlled Chromium session for a protected agent session.

Session requirements:

- isolated browser context
- no access to user’s normal browser profile
- short-lived
- collar-bound
- mode can be headless or visible
- current URL tracked
- session can be paused
- session can be closed

Routes:

- POST /sessions
- GET /sessions
- GET /sessions/:id
- POST /sessions/:id/navigate
- POST /sessions/:id/click
- POST /sessions/:id/type
- POST /sessions/:id/close

For MVP, the agent can control the browser through simple API calls.

Later, expose this through MCP.

Browser tool examples:

- navigate(url)
- click(selector or text)
- type(selector, value)
- read_page()
- screenshot()

Success criteria:

- session launches browser
- agent can navigate
- agent can read current URL
- agent can click and type
- session is isolated
- session can be closed
- session expires correctly

## Milestone 6: Sensitive Action Detector

Goal:

Detect when the agent is approaching a sensitive action.

Start rule-based.

Detection sources:

- URL
- DOM inputs
- button text
- form labels
- nearby text
- network request metadata if easy
- file upload fields

Initial sensitive detections:

- login
- password field
- checkout page
- payment field
- credit card field
- place order button
- subscribe button
- post/send/publish button
- file upload
- form submission
- identity fields
- address/phone/email fields

Example detection output:

{
  "action_type": "purchase",
  "risk_level": "high",
  "reason": "Clicked button with text Place Order on checkout page.",
  "domain": "nike.com"
}

Implementation approach:

- before click, inspect target element text and nearby text
- before type, inspect input type, name, autocomplete, label
- after navigation, scan page for sensitive forms
- before submit, classify form

Success criteria:

- detects password field
- detects checkout URL
- detects payment input
- detects place order button
- detects post/send button
- detects file upload input
- passes action type to policy engine

## Milestone 7: Enforcement Loop

Goal:

Connect detector to policy engine.

Flow:

1. Agent requests browser action.
2. Aegis inspects action.
3. Detector classifies risk.
4. Policy engine evaluates collar.
5. If allow, action proceeds.
6. If block, action is denied.
7. If approval_required, session pauses and approval request is created.
8. If runner_required, action waits for approval and runner.

Routes:

- POST /sessions/:id/action
- internal detectAction()
- internal evaluateAction()
- internal createApprovalRequest()

Success criteria:

- allowed browsing proceeds
- blocked action does not execute
- approval-required action pauses
- approval request appears in UI
- session can resume after approval
- denied action remains blocked

## Milestone 8: Approval Inbox

Goal:

Create a user-facing approval inbox for sensitive actions.

UI should show:

- pending approvals
- agent/session name
- collar name
- action type
- domain
- reason
- risk level
- approve button
- deny button
- view session button if available

Approval states:

- pending
- approved
- denied
- expired

Routes:

- GET /approvals
- GET /approvals/:id
- POST /approvals/:id/approve
- POST /approvals/:id/deny

On approve:

- resume action if safe
- or trigger runner
- create receipt

On deny:

- block action
- create receipt
- optionally resume browsing

Success criteria:

- approval appears when sensitive action triggered
- user can approve
- user can deny
- decision affects session
- receipt created

## Milestone 9: Aegis Runner

Goal:

Implement a simple simulated Runner.

The Runner represents Aegis performing sensitive execution without giving secrets to the outside agent.

For MVP, Runner can be mocked.

Runner examples:

- complete mock checkout
- fill mock payment
- submit approved form
- publish approved text in mock site
- disclose mock verified student claim

Runner task object:

{
  "runner_task": "complete_approved_purchase",
  "session_id": "sess_123",
  "domain": "demo-store.local",
  "amount_max": 89.99,
  "expires_in_seconds": 120,
  "can_use_payment": true,
  "can_save_payment_method": false,
  "can_buy_subscription": false
}

Success criteria:

- approval can trigger runner
- runner performs or simulates action
- runner cannot do unrelated action
- runner creates receipt
- runner terminates

## Milestone 10: Receipts

Goal:

Create receipts for trust-relevant events.

Receipt events:

- action allowed
- action blocked
- approval requested
- approval approved
- approval denied
- runner completed
- runner failed
- session revoked
- suspicious action detected

Receipt fields:

- id
- session_id
- collar_id
- action_type
- decision
- domain
- reason
- outcome
- created_at

UI should show:

- receipt list
- receipt detail
- simple explanation

Success criteria:

- receipts created for approvals
- receipts created for blocks
- receipts created for runner completion
- receipts are visible in UI
- receipts avoid storing raw secrets

## Milestone 11: Basic Reputation Events

Goal:

Create simple reputation events from receipts.

MVP metrics:

- protected sessions created
- sensitive actions requested
- actions approved
- actions denied
- risky actions blocked
- receipts created
- issues reported

Event fields:

- id
- entity_type
- entity_id
- event_type
- category
- session_id
- receipt_id
- severity
- created_at

Dashboard should show:

- protected sessions count
- approvals count
- blocks count
- receipts count
- issues count

Success criteria:

- reputation events created from receipts
- dashboard displays basic trust metrics
- no public score
- no overcollection

## Milestone 12: Demo Polish

Goal:

Make the prototype understandable in a 5-minute demo.

Required demo path:

1. Create custom collar.
2. Create Aegis Pass.
3. Agent requests protected session.
4. Browser opens or runs headless.
5. Agent browses demo store.
6. Agent adds item to cart.
7. Agent attempts checkout.
8. Aegis detects sensitive action.
9. Approval appears.
10. User approves.
11. Runner completes simulated purchase.
12. Receipt appears.
13. Reputation dashboard updates.

Demo UI should be clean but not overdesigned.

Important screens:

- Dashboard
- Create Pass
- Collar Editor
- Active Session
- Approval Inbox
- Receipts

Success criteria:

- viewer understands Aegis is not the agent builder
- viewer understands collars are customizable
- viewer sees agent browse freely
- viewer sees Aegis stop sensitive action
- viewer sees approval flow
- viewer sees receipt and reputation signal

## Milestone 13: Optional Mock Website

Goal:

Create a mock store or mock social site for reliable demo.

Why:

Real websites are messy and may block automation.

A mock site lets the demo clearly show detection and enforcement.

Mock store pages:

- home
- search results
- product page
- cart
- checkout
- payment form
- place order button

Sensitive elements:

- email field
- shipping address field
- credit card field
- place order button
- subscription checkbox
- upload ID field

Success criteria:

- detector catches sensitive elements
- runner can complete mock checkout
- demo is stable

## Milestone 14: Optional MCP Adapter

Goal:

Expose Aegis tools through MCP.

Initial tools:

- create_protected_session
- navigate
- click
- type
- read_page
- screenshot
- request_capability
- close_session

Why:

MCP makes Aegis easier to attach to outside agents.

Success criteria:

- MCP client can create session
- MCP client can control browser
- sensitive actions still go through Aegis
- approvals and receipts still work

## Build Order Summary

Recommended order:

1. Project setup
2. Data models
3. Collar engine
4. Collar UI
5. Aegis Pass
6. Protected browser session
7. Sensitive detector
8. Enforcement loop
9. Approval inbox
10. Simulated Runner
11. Receipts
12. Reputation events
13. Demo polish
14. Optional mock website
15. Optional MCP adapter

## First Claude/Codex Prompt

Use this prompt when starting implementation:

You are helping build Aegis, a trust and control layer for autonomous AI agents.

Aegis is not an agent builder. It lets users attach customizable collars to outside agents so those agents can browse freely but must go through Aegis for sensitive actions like login, payment, posting, messaging, file upload, form submission, and identity disclosure.

The first MVP should prove this loop:

1. User creates a customizable collar.
2. User creates an Aegis Pass for an outside agent.
3. Agent uses the pass to request a protected browser session.
4. Aegis launches an isolated Playwright/Chromium session.
5. Agent can browse freely.
6. Aegis detects sensitive action boundaries.
7. Aegis checks the collar.
8. Aegis allows, blocks, or requests approval.
9. Approval inbox lets user approve or deny.
10. Aegis Runner simulates sensitive execution.
11. Receipt is created.
12. Basic reputation event is recorded.

Do not build a full password manager, full identity verification, full reputation graph, agent marketplace, or enterprise admin system.

Focus only on the MVP.

Preserve these principles:

- Agents are disposable. Trust is not.
- Aegis is not an agent builder.
- Collars are customizable policy objects.
- Templates are only starting points.
- Agents can browse. Aegis decides when they can commit.
- Do not give agents raw secrets.
- Aegis turns secrets into controlled capabilities.
- Receipts record trust-relevant events, not everything.

Start by inspecting the current repo structure and proposing the smallest implementation plan before editing files.

## Non-Goals

Do not build:

- production security
- real financial transaction handling
- real identity verification
- real password storage
- full business verification
- real liability system
- public reputation score
- complex AI risk classifier
- universal browser compatibility
- custom browser UI from scratch

## Risk Notes

### Browser automation risk

Real sites may block automation.

Use a mock store for initial demo.

### Detection risk

Sensitive action detection will be imperfect.

Start with clear rules and high-confidence boundaries.

### UX risk

Too many approvals will kill the product.

Only ask for approval when risk crosses meaningful thresholds.

### Privacy risk

Overcollection will damage trust.

Log trust-relevant receipts, not everything.

### Product drift risk

The product may drift into password manager, agent builder, or browser automation.

Keep the focus on collars, protected sessions, approvals, runners, receipts, and reputation.

## Core Lines To Preserve

- Agents are disposable. Trust is not.
- Aegis is the collar you put on AI agents before letting them act for you.
- Do not give your agent your password. Give it an Aegis Pass.
- Agents can browse. Aegis decides when they can commit.
- Outside agents plan. Aegis executes sensitive steps.
- Aegis turns secrets into controlled capabilities.
- Aegis lets agents use your authority without possessing your secrets.
- Aegis reputation is a history of how safely your agents act under verified delegation.


