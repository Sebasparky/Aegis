# API_SPEC.md

## Purpose

This document defines the first API surface for the Aegis MVP.

The API should support the core loop:

1. User creates a customizable collar.
2. User creates an Aegis Pass for an outside agent.
3. Outside agent uses the pass to request a protected browser session.
4. Agent controls the browser through Aegis.
5. Aegis detects sensitive action boundaries.
6. Aegis evaluates the collar.
7. Aegis allows, blocks, or requests approval.
8. User approves or denies.
9. Aegis Runner simulates sensitive execution.
10. Aegis creates receipts.
11. Aegis records basic reputation events.

Core line:

> Agents can browse. Aegis decides when they can commit.

## API Design Principles

### 1. Do not expose raw secrets

The API should never return raw passwords, card numbers, full identity documents, or unrestricted tokens to agents.

Agents request capabilities.

Aegis decides what to release or execute.

### 2. Treat outside agents as untrusted

Agent-facing endpoints should validate:

- Aegis Pass token
- pass status
- pass expiration
- collar status
- session status
- requested action

### 3. Keep MVP routes simple

The MVP does not need perfect production API design.

It needs clear routes that prove the product loop.

### 4. Separate user-facing and agent-facing APIs

User-facing APIs are for the dashboard.

Agent-facing APIs are for outside agents requesting sessions and browser actions.

### 5. Receipts should be created for trust-relevant events

Any sensitive decision should create a receipt.

## Base URL

For local MVP:

http://localhost:4000

Example namespaces:

- /api/user/*
- /api/collars/*
- /api/passes/*
- /api/agent/*
- /api/sessions/*
- /api/approvals/*
- /api/receipts/*
- /api/reputation/*

## Auth Model For MVP

MVP can use mock auth or a single test user.

Do not overbuild auth early.

Suggested MVP assumption:

- user_id is derived from mock session
- agent requests authenticate with Aegis Pass token
- admin/dev mode can inspect all local test data

Future versions should use real authentication.

## Common Response Shape

Successful response:

{
  "ok": true,
  "data": {}
}

Error response:

{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message"
  }
}

## Error Codes

Common error codes:

- UNAUTHORIZED
- FORBIDDEN
- NOT_FOUND
- VALIDATION_ERROR
- PASS_EXPIRED
- PASS_REVOKED
- COLLAR_REVOKED
- SESSION_EXPIRED
- SESSION_PAUSED
- ACTION_BLOCKED
- APPROVAL_REQUIRED
- INTERNAL_ERROR

## Health

### GET /health

Returns API health.

Response:

{
  "ok": true,
  "data": {
    "status": "healthy"
  }
}

## User APIs

For MVP, user APIs can be minimal.

### GET /api/user/me

Returns current mock user.

Response:

{
  "ok": true,
  "data": {
    "id": "user_123",
    "email": "user@example.com",
    "aegis_id": "aid_user_123"
  }
}

## Collar APIs

Collars are customizable policy objects.

Templates may exist, but collars should be generic.

### GET /api/collars

List collars for current user.

Response:

{
  "ok": true,
  "data": [
    {
      "id": "collar_123",
      "name": "Custom Shopping Collar",
      "purpose": "Find and optionally buy running shoes under strict limits",
      "status": "active",
      "created_at": "2026-04-26T00:00:00Z"
    }
  ]
}

### POST /api/collars

Create a custom collar.

Request:

{
  "name": "Custom Shopping Collar",
  "purpose": "Find and optionally buy running shoes under strict limits",
  "allowed_actions": [
    "browse",
    "search",
    "compare",
    "read",
    "add_to_cart"
  ],
  "approval_required_actions": [
    "login",
    "purchase",
    "payment",
    "share_email",
    "share_phone",
    "submit_form"
  ],
  "blocked_actions": [
    "subscription",
    "government_id_upload",
    "identity_disclosure"
  ],
  "spending_limits": {
    "max_without_approval": 0,
    "max_with_approval": 100,
    "subscriptions_allowed": false
  },
  "counterparty_rules": {
    "sensitive_actions_require_verified_business": false,
    "block_known_prompt_injection_sites": true
  },
  "session_limits": {
    "max_duration_minutes": 120
  }
}

Response:

{
  "ok": true,
  "data": {
    "id": "collar_123",
    "name": "Custom Shopping Collar",
    "status": "active"
  }
}

### GET /api/collars/:collarId

Get collar detail.

Response:

{
  "ok": true,
  "data": {
    "id": "collar_123",
    "name": "Custom Shopping Collar",
    "purpose": "Find and optionally buy running shoes under strict limits",
    "allowed_actions": [
      "browse",
      "search",
      "compare",
      "read",
      "add_to_cart"
    ],
    "approval_required_actions": [
      "login",
      "purchase",
      "payment",
      "share_email",
      "share_phone",
      "submit_form"
    ],
    "blocked_actions": [
      "subscription",
      "government_id_upload",
      "identity_disclosure"
    ],
    "status": "active"
  }
}

### PATCH /api/collars/:collarId

Update collar.

Request may include any collar fields.

Response:

{
  "ok": true,
  "data": {
    "id": "collar_123",
    "status": "active",
    "updated": true
  }
}

### POST /api/collars/:collarId/revoke

Revoke collar.

Response:

{
  "ok": true,
  "data": {
    "id": "collar_123",
    "status": "revoked"
  }
}

### GET /api/collars/templates

List editable starter templates.

Templates are examples, not hardcoded limits.

Response:

{
  "ok": true,
  "data": [
    {
      "id": "template_shopping",
      "name": "Shopping Starter",
      "description": "Browse and compare freely. Require approval for purchase and payment."
    },
    {
      "id": "template_social",
      "name": "Social Starter",
      "description": "Draft freely. Require approval before posting or messaging."
    }
  ]
}

## Aegis Pass APIs

Aegis Passes let outside agents request Aegis-controlled capabilities.

### GET /api/passes

List passes for current user.

Response:

{
  "ok": true,
  "data": [
    {
      "id": "pass_123",
      "agent_name": "Shopping Agent",
      "purpose": "Find running shoes under $100",
      "default_collar_id": "collar_123",
      "status": "active",
      "expires_at": "2026-04-27T00:00:00Z"
    }
  ]
}

### POST /api/passes

Create an Aegis Pass.

Request:

{
  "agent_name": "Shopping Agent",
  "purpose": "Find running shoes under $100",
  "default_collar_id": "collar_123",
  "expires_in_minutes": 120
}

Response:

{
  "ok": true,
  "data": {
    "id": "pass_123",
    "agent_name": "Shopping Agent",
    "token": "aegis_pass_token_example",
    "default_collar_id": "collar_123",
    "status": "active",
    "expires_at": "2026-04-27T00:00:00Z"
  }
}

Important:

The token should only be shown once in real production.

For MVP, simplicity is acceptable.

### GET /api/passes/:passId

Get pass detail.

Response:

{
  "ok": true,
  "data": {
    "id": "pass_123",
    "agent_name": "Shopping Agent",
    "purpose": "Find running shoes under $100",
    "default_collar_id": "collar_123",
    "status": "active",
    "expires_at": "2026-04-27T00:00:00Z"
  }
}

### POST /api/passes/:passId/revoke

Revoke pass.

Response:

{
  "ok": true,
  "data": {
    "id": "pass_123",
    "status": "revoked"
  }
}

## Agent-Facing APIs

These endpoints are used by outside agents.

The outside agent should use an Aegis Pass token.

### POST /api/agent/create-session

Agent requests a protected browser session.

Request:

{
  "agent_pass_token": "aegis_pass_token_example",
  "purpose": "Find running shoes under $100",
  "requested_collar_id": "collar_123",
  "mode": "headless"
}

Response:

{
  "ok": true,
  "data": {
    "session_id": "sess_123",
    "collar_id": "collar_123",
    "status": "active",
    "mode": "headless",
    "expires_at": "2026-04-27T00:00:00Z",
    "allowed_actions": [
      "browse",
      "search",
      "compare",
      "read",
      "add_to_cart"
    ],
    "approval_required_actions": [
      "login",
      "purchase",
      "payment",
      "share_email",
      "share_phone",
      "submit_form"
    ],
    "blocked_actions": [
      "subscription",
      "government_id_upload",
      "identity_disclosure"
    ]
  }
}

### POST /api/agent/session/:sessionId/navigate

Navigate protected browser session.

Request:

{
  "agent_pass_token": "aegis_pass_token_example",
  "url": "https://example.com"
}

Response:

{
  "ok": true,
  "data": {
    "session_id": "sess_123",
    "current_url": "https://example.com",
    "decision": "allow"
  }
}

### POST /api/agent/session/:sessionId/read-page

Read current page summary or text.

Request:

{
  "agent_pass_token": "aegis_pass_token_example"
}

Response:

{
  "ok": true,
  "data": {
    "session_id": "sess_123",
    "current_url": "https://example.com",
    "title": "Example Store",
    "text_preview": "Page content preview..."
  }
}

### POST /api/agent/session/:sessionId/click

Request click action.

Request:

{
  "agent_pass_token": "aegis_pass_token_example",
  "target": {
    "type": "text",
    "value": "Place Order"
  }
}

Possible allow response:

{
  "ok": true,
  "data": {
    "decision": "allow",
    "session_id": "sess_123",
    "current_url": "https://example.com/product"
  }
}

Possible approval response:

{
  "ok": true,
  "data": {
    "decision": "approval_required",
    "session_id": "sess_123",
    "approval_request_id": "approval_123",
    "reason": "This collar requires approval before purchase."
  }
}

Possible block response:

{
  "ok": true,
  "data": {
    "decision": "block",
    "session_id": "sess_123",
    "reason": "This collar blocks subscriptions."
  }
}

### POST /api/agent/session/:sessionId/type

Request typing into a field.

Request:

{
  "agent_pass_token": "aegis_pass_token_example",
  "target": {
    "selector": "input[name='email']"
  },
  "value": "user@example.com"
}

Response if allowed:

{
  "ok": true,
  "data": {
    "decision": "allow",
    "session_id": "sess_123"
  }
}

Response if approval required:

{
  "ok": true,
  "data": {
    "decision": "approval_required",
    "approval_request_id": "approval_123",
    "reason": "Sharing email requires approval under this collar."
  }
}

### POST /api/agent/session/:sessionId/screenshot

Take session screenshot.

Request:

{
  "agent_pass_token": "aegis_pass_token_example"
}

Response:

{
  "ok": true,
  "data": {
    "session_id": "sess_123",
    "screenshot_url": "/api/sessions/sess_123/screenshot"
  }
}

### POST /api/agent/session/:sessionId/request-capability

Agent requests a sensitive capability directly.

Request:

{
  "agent_pass_token": "aegis_pass_token_example",
  "capability": "purchase",
  "context": {
    "domain": "example-store.com",
    "amount": 89.99,
    "item_summary": "Running shoes",
    "subscription": false
  }
}

Response:

{
  "ok": true,
  "data": {
    "decision": "approval_required",
    "approval_request_id": "approval_123",
    "reason": "Purchases require approval under this collar."
  }
}

### POST /api/agent/session/:sessionId/close

Close protected session.

Request:

{
  "agent_pass_token": "aegis_pass_token_example"
}

Response:

{
  "ok": true,
  "data": {
    "session_id": "sess_123",
    "status": "closed"
  }
}

## Session APIs

User-facing session management.

### GET /api/sessions

List user sessions.

Response:

{
  "ok": true,
  "data": [
    {
      "id": "sess_123",
      "agent_name": "Shopping Agent",
      "collar_id": "collar_123",
      "status": "active",
      "current_url": "https://example.com",
      "created_at": "2026-04-26T00:00:00Z",
      "expires_at": "2026-04-27T00:00:00Z"
    }
  ]
}

### GET /api/sessions/:sessionId

Get session detail.

Response:

{
  "ok": true,
  "data": {
    "id": "sess_123",
    "agent_name": "Shopping Agent",
    "collar_id": "collar_123",
    "status": "active",
    "mode": "headless",
    "current_url": "https://example.com",
    "recent_activity": []
  }
}

### POST /api/sessions/:sessionId/pause

Pause session.

Response:

{
  "ok": true,
  "data": {
    "id": "sess_123",
    "status": "paused"
  }
}

### POST /api/sessions/:sessionId/resume

Resume session.

Response:

{
  "ok": true,
  "data": {
    "id": "sess_123",
    "status": "active"
  }
}

### POST /api/sessions/:sessionId/revoke

Revoke session.

Response:

{
  "ok": true,
  "data": {
    "id": "sess_123",
    "status": "revoked"
  }
}

## Policy Evaluation API

This can be internal only at first.

### POST /api/policy/evaluate

Evaluate an action against a collar.

Request:

{
  "collar_id": "collar_123",
  "session_id": "sess_123",
  "action_type": "purchase",
  "domain": "example-store.com",
  "context": {
    "amount": 89.99,
    "subscription": false
  }
}

Response:

{
  "ok": true,
  "data": {
    "decision": "approval_required",
    "reason": "This collar requires approval before purchase.",
    "risk_level": "high"
  }
}

Decision values:

- allow
- allow_and_log
- approval_required
- runner_required
- block
- pause_session
- revoke_session

## Approval APIs

### GET /api/approvals

List approval requests.

Optional query:

- status=pending
- session_id=sess_123

Response:

{
  "ok": true,
  "data": [
    {
      "id": "approval_123",
      "session_id": "sess_123",
      "action_type": "purchase",
      "risk_level": "high",
      "domain": "example-store.com",
      "summary": "Purchase running shoes for $89.99",
      "reason": "Purchases require approval under this collar.",
      "status": "pending",
      "created_at": "2026-04-26T00:00:00Z"
    }
  ]
}

### GET /api/approvals/:approvalId

Get approval detail.

Response:

{
  "ok": true,
  "data": {
    "id": "approval_123",
    "session_id": "sess_123",
    "action_type": "purchase",
    "risk_level": "high",
    "domain": "example-store.com",
    "summary": "Purchase running shoes for $89.99",
    "reason": "Purchases require approval under this collar.",
    "status": "pending",
    "context": {
      "amount": 89.99,
      "item_summary": "Running shoes"
    }
  }
}

### POST /api/approvals/:approvalId/approve

Approve sensitive action.

Request:

{
  "note": "Approved once"
}

Response:

{
  "ok": true,
  "data": {
    "id": "approval_123",
    "status": "approved",
    "receipt_id": "rec_123",
    "runner_task_id": "runner_123"
  }
}

### POST /api/approvals/:approvalId/deny

Deny sensitive action.

Request:

{
  "note": "Do not buy this"
}

Response:

{
  "ok": true,
  "data": {
    "id": "approval_123",
    "status": "denied",
    "receipt_id": "rec_124"
  }
}

## Runner APIs

For MVP, runners can be internal or simulated.

### GET /api/runners

List runner tasks.

Response:

{
  "ok": true,
  "data": [
    {
      "id": "runner_123",
      "session_id": "sess_123",
      "task_type": "complete_approved_purchase",
      "status": "completed",
      "created_at": "2026-04-26T00:00:00Z"
    }
  ]
}

### POST /api/runners/:runnerId/execute

Execute runner task.

For MVP, this may simulate completion.

Response:

{
  "ok": true,
  "data": {
    "id": "runner_123",
    "status": "completed",
    "receipt_id": "rec_125"
  }
}

## Receipt APIs

### GET /api/receipts

List receipts.

Optional query:

- session_id=sess_123
- action_type=purchase

Response:

{
  "ok": true,
  "data": [
    {
      "id": "rec_123",
      "session_id": "sess_123",
      "collar_id": "collar_123",
      "action_type": "purchase",
      "decision": "approved_by_user",
      "domain": "example-store.com",
      "outcome": "completed",
      "created_at": "2026-04-26T00:00:00Z"
    }
  ]
}

### GET /api/receipts/:receiptId

Get receipt detail.

Response:

{
  "ok": true,
  "data": {
    "id": "rec_123",
    "session_id": "sess_123",
    "collar_id": "collar_123",
    "action_type": "purchase",
    "decision": "approved_by_user",
    "domain": "example-store.com",
    "reason": "User approved purchase request.",
    "outcome": "completed",
    "sensitive_data_shared_with_agent": false,
    "created_at": "2026-04-26T00:00:00Z"
  }
}

### POST /api/receipts/:receiptId/report-issue

User reports issue with receipt.

Request:

{
  "issue_type": "wrong_item",
  "description": "The agent selected the wrong product."
}

Response:

{
  "ok": true,
  "data": {
    "receipt_id": "rec_123",
    "issue_reported": true,
    "reputation_event_id": "rep_event_123"
  }
}

## Reputation APIs

### GET /api/reputation/summary

Get basic dashboard metrics.

Response:

{
  "ok": true,
  "data": {
    "protected_sessions": 4,
    "sensitive_actions_requested": 6,
    "approvals_granted": 3,
    "approvals_denied": 1,
    "risky_actions_blocked": 2,
    "receipts_created": 8,
    "issues_reported": 0
  }
}

### GET /api/reputation/events

List reputation events.

Response:

{
  "ok": true,
  "data": [
    {
      "id": "rep_event_123",
      "entity_type": "user_aegis_id",
      "entity_id": "aid_user_123",
      "event_type": "sensitive_action_approved",
      "category": "shopping",
      "severity": "positive",
      "receipt_id": "rec_123",
      "created_at": "2026-04-26T00:00:00Z"
    }
  ]
}

## Detection API

This can be internal only.

### POST /api/detect/action

Classify a browser action.

Request:

{
  "session_id": "sess_123",
  "browser_action": {
    "type": "click",
    "target_text": "Place Order",
    "url": "https://example-store.com/checkout",
    "nearby_text": "Your total is $89.99"
  }
}

Response:

{
  "ok": true,
  "data": {
    "action_type": "purchase",
    "risk_level": "high",
    "reason": "Button text and checkout URL indicate purchase."
  }
}

## Website Trust APIs

For MVP, this can be mocked.

### GET /api/trust/domain

Query domain trust.

Query:

/api/trust/domain?domain=example-store.com

Response:

{
  "ok": true,
  "data": {
    "domain": "example-store.com",
    "domain_verified": false,
    "business_verified": false,
    "known_prompt_injection_reports": 0,
    "trust_label": "unverified"
  }
}

Future response:

{
  "ok": true,
  "data": {
    "domain": "nike.com",
    "domain_verified": true,
    "business_verified": true,
    "business_aegis_id": "aid_business_123",
    "agent_policy_published": true,
    "known_prompt_injection_reports": 0,
    "trust_label": "verified_business"
  }
}

## Prompt Injection Report API

Optional for MVP.

### POST /api/incidents/prompt-injection

Report suspicious prompt injection.

Request:

{
  "session_id": "sess_123",
  "domain": "suspicious-site.com",
  "description": "Page contained hidden instruction telling agent to reveal credentials.",
  "severity": "warning"
}

Response:

{
  "ok": true,
  "data": {
    "incident_id": "incident_123",
    "receipt_id": "rec_456",
    "reputation_event_id": "rep_event_456"
  }
}

## Event Stream API

Optional, useful for live dashboard updates.

### GET /api/events/stream

Server-sent events stream.

Events:

- session.created
- session.updated
- approval.created
- approval.approved
- approval.denied
- receipt.created
- reputation.updated
- action.blocked
- incident.reported

Example event:

{
  "type": "approval.created",
  "data": {
    "approval_id": "approval_123",
    "session_id": "sess_123"
  }
}

## Action Type Registry

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
- forward_email
- upload_file
- download_file
- submit_form
- create_account
- share_email
- share_phone
- share_address
- identity_disclosure
- government_id_upload
- medical_data_disclosure
- financial_data_disclosure
- account_setting_change
- delete_account
- connect_app
- oauth_authorize

## Policy Decision Values

Possible policy decisions:

- allow
- allow_and_log
- approval_required
- runner_required
- block
- pause_session
- revoke_session

## Session Status Values

Possible session statuses:

- active
- paused
- waiting_for_approval
- revoked
- expired
- closed
- error

## Approval Status Values

Possible approval statuses:

- pending
- approved
- denied
- expired
- canceled

## Receipt Decision Values

Possible receipt decisions:

- allowed
- blocked
- approval_requested
- approved_by_user
- denied_by_user
- completed_by_runner
- failed
- revoked

## Reputation Event Severity

Possible severity values:

- info
- positive
- warning
- negative
- critical

## Minimum MVP Route Set

If implementation needs to be smaller, start with only these routes:

- GET /health
- POST /api/collars
- GET /api/collars
- POST /api/passes
- GET /api/passes
- POST /api/agent/create-session
- POST /api/agent/session/:sessionId/navigate
- POST /api/agent/session/:sessionId/click
- GET /api/approvals
- POST /api/approvals/:approvalId/approve
- POST /api/approvals/:approvalId/deny
- GET /api/receipts
- GET /api/reputation/summary

This is enough to prove the demo.

## API Non-Goals For MVP

Do not implement:

- real payment API
- real password vault API
- real government ID API
- real business verification API
- public reputation API
- OAuth marketplace
- enterprise admin API
- insurance or liability API
- production cryptographic signing

## Core Lines To Preserve

- Agents can browse. Aegis decides when they can commit.
- Do not give your agent your password. Give it an Aegis Pass.
- The agent asks. Aegis decides.
- The pass is access. The collar is policy.
- Outside agents plan. Aegis executes sensitive steps.
- Aegis turns secrets into controlled capabilities.
- Receipts record trust-relevant events, not everything.


