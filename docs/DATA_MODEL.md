# DATA_MODEL.md

## Purpose

This document defines the first data model for the Aegis MVP.

The goal is to support the core product loop:

1. User creates a customizable collar.
2. User creates an Aegis Pass for an outside agent.
3. Outside agent requests a protected browser session.
4. Aegis launches a controlled browser session.
5. Agent browses freely.
6. Aegis detects sensitive action boundaries.
7. Aegis checks the collar.
8. Aegis allows, blocks, or requests approval.
9. Aegis Runner executes approved sensitive steps.
10. Aegis creates receipts.
11. Aegis records basic reputation events.

Core line:

> Agents can browse. Aegis decides when they can commit.

## Design Principles

### 1. Keep the MVP model simple

Do not overbuild the schema for future features.

The first data model should support:

- users
- Aegis Passes
- collars
- protected sessions
- approvals
- runner tasks
- receipts
- reputation events
- basic domain trust

### 2. Collars should be generic

Do not hardcode shopping, social, travel, or finance into the database model.

Templates can exist, but the underlying collar should be a customizable policy object.

Good:

- allowed_actions
- approval_required_actions
- blocked_actions
- spending_limits
- counterparty_rules

Bad:

- shopping_can_purchase
- social_can_post
- travel_can_book

### 3. Store receipts, not surveillance

Do not store every click, scroll, page, token, or private message by default.

Store trust-relevant events.

### 4. Do not store raw secrets in MVP

For MVP, avoid storing:

- real passwords
- real credit card numbers
- real government IDs
- real private documents
- real OAuth refresh tokens

Use mock data where needed.

### 5. Use JSON fields for flexibility

Early collar policies will evolve quickly.

Use JSON fields for configurable policy areas like:

- spending limits
- identity claim permissions
- counterparty rules
- session limits
- receipt settings

Later, these can be normalized if needed.

## Entity Overview

Core entities:

1. users
2. aegis_ids
3. collars
4. aegis_passes
5. protected_sessions
6. approval_requests
7. runner_tasks
8. receipts
9. reputation_events
10. domain_trust_records
11. incident_reports

Optional later entities:

- verified_claims
- business_profiles
- website_profiles
- api_profiles
- vault_items
- trusted_contacts
- dispute_records

## users

Represents an account in Aegis.

For MVP, this can be a simple mock user.

Fields:

- id
- email
- display_name
- created_at
- updated_at

Example:

{
  "id": "user_123",
  "email": "user@example.com",
  "display_name": "Sebastian",
  "created_at": "2026-04-26T00:00:00Z",
  "updated_at": "2026-04-26T00:00:00Z"
}

Notes:

- Real authentication can come later.
- For MVP, a single local user is acceptable.

## aegis_ids

Represents durable Aegis identity objects.

AegisID may represent users, agent sessions, businesses, websites, or APIs.

For MVP, only user and agent_session types are required.

Fields:

- id
- type
- user_id
- display_name
- status
- metadata
- created_at
- updated_at

Type values:

- user
- agent_session
- business
- website
- api

Status values:

- active
- revoked
- suspended
- archived

Example User AegisID:

{
  "id": "aid_user_123",
  "type": "user",
  "user_id": "user_123",
  "display_name": "Sebastian's AegisID",
  "status": "active",
  "metadata": {},
  "created_at": "2026-04-26T00:00:00Z",
  "updated_at": "2026-04-26T00:00:00Z"
}

Example Agent Session AegisID:

{
  "id": "aid_session_456",
  "type": "agent_session",
  "user_id": "user_123",
  "display_name": "Shopping Agent Session",
  "status": "active",
  "metadata": {
    "aegis_pass_id": "pass_123",
    "collar_id": "collar_789",
    "task_purpose": "Find running shoes under $100"
  },
  "created_at": "2026-04-26T00:00:00Z",
  "updated_at": "2026-04-26T00:00:00Z"
}

## collars

Represents a customizable policy object attached to an agent session or Aegis Pass.

Fields:

- id
- user_id
- name
- description
- purpose
- status
- allowed_actions
- approval_required_actions
- blocked_actions
- spending_limits
- identity_claim_rules
- credential_rules
- counterparty_rules
- file_rules
- messaging_rules
- session_limits
- receipt_settings
- created_at
- updated_at
- revoked_at

Status values:

- active
- revoked
- archived

Example:

{
  "id": "collar_123",
  "user_id": "user_123",
  "name": "Custom Shopping Collar",
  "description": "Allows product research but gates checkout and payment.",
  "purpose": "Find and optionally buy running shoes under strict payment limits.",
  "status": "active",
  "allowed_actions": [
    "browse",
    "search",
    "read",
    "compare",
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
  "identity_claim_rules": {
    "verified_student": {
      "allowed": true,
      "requires_approval": true,
      "disclosure": "claim_only"
    }
  },
  "credential_rules": {
    "raw_secret_exposure_allowed": false
  },
  "counterparty_rules": {
    "sensitive_actions_require_verified_business": false,
    "block_known_prompt_injection_sites": true
  },
  "file_rules": {
    "uploads_require_approval": true,
    "blocked_file_categories": [
      "government_id",
      "medical_record",
      "tax_document"
    ]
  },
  "messaging_rules": {
    "public_post_requires_approval": true,
    "new_recipient_requires_approval": true
  },
  "session_limits": {
    "max_duration_minutes": 120,
    "max_active_sessions": 1
  },
  "receipt_settings": {
    "create_receipts_for_sensitive_actions": true,
    "detail_level": "minimal"
  },
  "created_at": "2026-04-26T00:00:00Z",
  "updated_at": "2026-04-26T00:00:00Z",
  "revoked_at": null
}

Notes:

- Arrays can be stored as JSON for MVP.
- Later, action rules may become separate rows.
- Collars should be customizable first. Templates are only starting points.

## collar_templates

Optional helper table for starter templates.

Templates are not the real product. They are only starting points.

Fields:

- id
- name
- description
- template_data
- created_at
- updated_at

Example:

{
  "id": "template_shopping",
  "name": "Shopping Starter",
  "description": "Browse and compare freely. Require approval before purchase.",
  "template_data": {
    "allowed_actions": ["browse", "search", "read", "compare", "add_to_cart"],
    "approval_required_actions": ["login", "purchase", "payment", "share_email", "share_phone"],
    "blocked_actions": ["subscription", "government_id_upload"]
  },
  "created_at": "2026-04-26T00:00:00Z",
  "updated_at": "2026-04-26T00:00:00Z"
}

## aegis_passes

Represents the access object given to an outside agent.

The Aegis Pass lets the agent request Aegis-controlled capabilities.

It should not contain raw secrets.

Fields:

- id
- user_id
- token_hash
- agent_name
- purpose
- default_collar_id
- allowed_collar_ids
- status
- expires_at
- last_used_at
- created_at
- updated_at
- revoked_at

Status values:

- active
- revoked
- expired

Example:

{
  "id": "pass_123",
  "user_id": "user_123",
  "token_hash": "hashed_token_value",
  "agent_name": "Shopping Agent",
  "purpose": "Find running shoes under $100",
  "default_collar_id": "collar_123",
  "allowed_collar_ids": ["collar_123"],
  "status": "active",
  "expires_at": "2026-04-27T00:00:00Z",
  "last_used_at": null,
  "created_at": "2026-04-26T00:00:00Z",
  "updated_at": "2026-04-26T00:00:00Z",
  "revoked_at": null
}

Notes:

- Store token hash, not raw token.
- The raw token should only be shown once in production.
- MVP may simplify this temporarily.

## protected_sessions

Represents a controlled browser session.

Fields:

- id
- user_id
- aegis_pass_id
- collar_id
- agent_session_aegis_id
- status
- mode
- current_url
- current_domain
- browser_context_id
- browser_page_id
- created_at
- updated_at
- expires_at
- paused_at
- closed_at
- revoked_at

Status values:

- active
- paused
- waiting_for_approval
- revoked
- expired
- closed
- error

Mode values:

- headless
- visible

Example:

{
  "id": "sess_123",
  "user_id": "user_123",
  "aegis_pass_id": "pass_123",
  "collar_id": "collar_123",
  "agent_session_aegis_id": "aid_session_456",
  "status": "active",
  "mode": "headless",
  "current_url": "https://example-store.com",
  "current_domain": "example-store.com",
  "browser_context_id": "ctx_123",
  "browser_page_id": "page_123",
  "created_at": "2026-04-26T00:00:00Z",
  "updated_at": "2026-04-26T00:00:00Z",
  "expires_at": "2026-04-26T02:00:00Z",
  "paused_at": null,
  "closed_at": null,
  "revoked_at": null
}

Notes:

- Do not use the user’s normal browser profile.
- Use isolated Playwright browser contexts.
- Sessions should be disposable.

## session_events

Optional but useful for lightweight activity.

This is not full surveillance. It is a minimal session activity log.

Fields:

- id
- session_id
- event_type
- action_type
- domain
- summary
- severity
- metadata
- created_at

Event examples:

- session_created
- navigation
- action_allowed
- sensitive_action_detected
- approval_created
- action_blocked
- session_paused
- session_resumed
- session_closed

Example:

{
  "id": "event_123",
  "session_id": "sess_123",
  "event_type": "sensitive_action_detected",
  "action_type": "purchase",
  "domain": "example-store.com",
  "summary": "Detected checkout action.",
  "severity": "warning",
  "metadata": {
    "detector_reason": "Clicked button with text Place Order on checkout page."
  },
  "created_at": "2026-04-26T00:00:00Z"
}

Notes:

- Keep event summaries minimal.
- Avoid full page contents or screenshots by default.

## approval_requests

Represents a user approval request for a sensitive action.

Fields:

- id
- user_id
- session_id
- collar_id
- action_type
- risk_level
- domain
- summary
- reason
- context
- status
- requested_by
- resolved_by
- created_at
- resolved_at
- expires_at

Status values:

- pending
- approved
- denied
- expired
- canceled

Risk levels:

- low
- medium
- high
- critical

Example:

{
  "id": "approval_123",
  "user_id": "user_123",
  "session_id": "sess_123",
  "collar_id": "collar_123",
  "action_type": "purchase",
  "risk_level": "high",
  "domain": "example-store.com",
  "summary": "Purchase running shoes for $89.99",
  "reason": "Purchases require approval under this collar.",
  "context": {
    "amount": 89.99,
    "item_summary": "Running shoes",
    "subscription": false
  },
  "status": "pending",
  "requested_by": "aegis_policy_engine",
  "resolved_by": null,
  "created_at": "2026-04-26T00:00:00Z",
  "resolved_at": null,
  "expires_at": "2026-04-26T00:10:00Z"
}

Notes:

- Approval context should be clear and concise.
- Avoid storing unnecessary private page data.
- Approval fatigue is a product and security risk.

## runner_tasks

Represents a temporary Aegis Runner task.

A Runner performs a sensitive step without exposing raw secrets to the outside agent.

Fields:

- id
- user_id
- session_id
- approval_request_id
- collar_id
- task_type
- status
- domain
- constraints
- result
- created_at
- started_at
- completed_at
- expires_at

Task types:

- complete_approved_purchase
- perform_login
- disclose_verified_claim
- send_approved_email
- publish_approved_post
- upload_approved_file
- submit_approved_form

Status values:

- pending
- running
- completed
- failed
- expired
- canceled

Example:

{
  "id": "runner_123",
  "user_id": "user_123",
  "session_id": "sess_123",
  "approval_request_id": "approval_123",
  "collar_id": "collar_123",
  "task_type": "complete_approved_purchase",
  "status": "pending",
  "domain": "example-store.com",
  "constraints": {
    "amount_max": 89.99,
    "can_use_payment": true,
    "can_save_payment_method": false,
    "can_buy_subscription": false
  },
  "result": null,
  "created_at": "2026-04-26T00:00:00Z",
  "started_at": null,
  "completed_at": null,
  "expires_at": "2026-04-26T00:02:00Z"
}

Notes:

- Runner tasks should be narrow.
- Runner tasks should expire quickly.
- For MVP, runners can be simulated.

## receipts

Represents trust-relevant records.

Receipts are the basis for accountability and reputation.

Fields:

- id
- user_id
- session_id
- collar_id
- aegis_pass_id
- action_type
- decision
- domain
- counterparty_trust_status
- reason
- outcome
- sensitive_data_shared_with_agent
- receipt_detail_level
- metadata
- created_at

Decision values:

- allowed
- blocked
- approval_requested
- approved_by_user
- denied_by_user
- completed_by_runner
- failed
- revoked

Outcome values:

- completed
- blocked
- denied
- failed
- pending
- canceled

Detail levels:

- minimal
- detailed
- forensic

Example:

{
  "id": "rec_123",
  "user_id": "user_123",
  "session_id": "sess_123",
  "collar_id": "collar_123",
  "aegis_pass_id": "pass_123",
  "action_type": "purchase",
  "decision": "approved_by_user",
  "domain": "example-store.com",
  "counterparty_trust_status": "unverified",
  "reason": "User approved purchase request.",
  "outcome": "completed",
  "sensitive_data_shared_with_agent": false,
  "receipt_detail_level": "minimal",
  "metadata": {
    "amount_bucket": "50_to_100"
  },
  "created_at": "2026-04-26T00:00:00Z"
}

Notes:

- Avoid raw secrets.
- Avoid full browsing logs.
- Store enough to prove what happened.

## reputation_events

Represents trust signals derived from receipts and other trust-relevant events.

Fields:

- id
- entity_type
- entity_id
- event_type
- category
- severity
- session_id
- receipt_id
- domain
- weight
- metadata
- created_at

Entity types:

- user_aegis_id
- agent_session_aegis_id
- business_aegis_id
- website_aegis_id
- api_aegis_id
- collar
- agent_platform

Severity values:

- info
- positive
- warning
- negative
- critical

Example user reputation event:

{
  "id": "rep_event_123",
  "entity_type": "user_aegis_id",
  "entity_id": "aid_user_123",
  "event_type": "sensitive_action_approved",
  "category": "shopping",
  "severity": "positive",
  "session_id": "sess_123",
  "receipt_id": "rec_123",
  "domain": "example-store.com",
  "weight": 1,
  "metadata": {},
  "created_at": "2026-04-26T00:00:00Z"
}

Example website reputation event:

{
  "id": "rep_event_456",
  "entity_type": "website_aegis_id",
  "entity_id": "aid_site_123",
  "event_type": "unverified_site_requested_sensitive_action",
  "category": "shopping",
  "severity": "warning",
  "session_id": "sess_123",
  "receipt_id": "rec_456",
  "domain": "suspicious-store.com",
  "weight": -1,
  "metadata": {
    "action_type": "payment"
  },
  "created_at": "2026-04-26T00:00:00Z"
}

Notes:

- MVP should keep reputation simple.
- Do not create public scores early.
- Use events for dashboard metrics and future trust graph.

## domain_trust_records

Represents basic domain trust for MVP.

This can start as mocked or manually seeded data.

Fields:

- id
- domain
- domain_verified
- business_verified
- business_aegis_id
- trust_label
- known_prompt_injection_reports
- known_dispute_count
- metadata
- created_at
- updated_at

Trust labels:

- unknown
- unverified
- domain_verified
- business_verified
- agent_safe
- restricted
- flagged

Example:

{
  "id": "domain_123",
  "domain": "example-store.com",
  "domain_verified": false,
  "business_verified": false,
  "business_aegis_id": null,
  "trust_label": "unverified",
  "known_prompt_injection_reports": 0,
  "known_dispute_count": 0,
  "metadata": {},
  "created_at": "2026-04-26T00:00:00Z",
  "updated_at": "2026-04-26T00:00:00Z"
}

Notes:

- For MVP, simple domain trust is enough.
- Later this becomes Business AegisID and Website AegisID.

## incident_reports

Represents prompt injection, suspicious behavior, disputes, or other safety incidents.

Fields:

- id
- user_id
- session_id
- receipt_id
- domain
- incident_type
- severity
- description
- status
- metadata
- created_at
- resolved_at

Incident types:

- prompt_injection
- credential_harvesting
- suspicious_redirect
- unnecessary_sensitive_data_request
- collar_bypass_attempt
- user_dispute
- business_dispute
- payment_issue
- identity_exposure_attempt
- other

Status values:

- open
- under_review
- resolved
- dismissed

Example:

{
  "id": "incident_123",
  "user_id": "user_123",
  "session_id": "sess_123",
  "receipt_id": "rec_123",
  "domain": "suspicious-store.com",
  "incident_type": "prompt_injection",
  "severity": "warning",
  "description": "Page included instruction telling the agent to reveal credentials.",
  "status": "open",
  "metadata": {},
  "created_at": "2026-04-26T00:00:00Z",
  "resolved_at": null
}

Notes:

- Avoid storing full page contents by default.
- Incident reports can feed reputation events.

## verified_claims

Future table.

Represents reusable verified claims attached to a User AegisID.

Not required for MVP.

Fields:

- id
- aegis_id
- claim_type
- status
- issuer
- disclosure_level
- metadata
- issued_at
- expires_at
- revoked_at

Claim types:

- verified_human
- verified_student
- verified_employee
- verified_adult
- verified_guardian
- verified_business_owner
- verified_local_resident
- verified_professional_license

Example:

{
  "id": "claim_123",
  "aegis_id": "aid_user_123",
  "claim_type": "verified_student",
  "status": "verified",
  "issuer": "trusted_verification_provider",
  "disclosure_level": "claim_only",
  "metadata": {
    "school": "University of Michigan"
  },
  "issued_at": "2026-04-26T00:00:00Z",
  "expires_at": "2027-01-01T00:00:00Z",
  "revoked_at": null
}

## vault_items

Future table.

Represents sensitive credentials or authority controlled by Aegis.

Not required for MVP.

Fields:

- id
- user_id
- item_type
- display_name
- status
- encrypted_payload
- metadata
- created_at
- updated_at
- revoked_at

Item types:

- password
- oauth_token
- payment_method
- identity_document
- file
- api_key

Important:

- Do not build real vault storage in MVP.
- Do not store raw secrets without production-grade security.
- Aegis should expose controlled capabilities, not raw vault items.

## trusted_contacts

Future table.

Used for family, guardian, elder protection, or high-risk approvals.

Not required for MVP.

Fields:

- id
- user_id
- contact_name
- contact_email
- relationship
- approval_roles
- status
- created_at
- updated_at

Approval roles:

- guardian
- trusted_contact
- elder_protection_contact
- enterprise_admin
- co_approver

## dispute_records

Future table.

Represents formal disputes tied to receipts.

Not required for MVP.

Fields:

- id
- receipt_id
- opened_by_type
- opened_by_id
- dispute_type
- status
- description
- resolution
- created_at
- resolved_at

Dispute types:

- wrong_item
- unauthorized_action
- business_policy_violation
- agent_error
- user_error
- prompt_injection
- payment_issue
- identity_issue

## Suggested SQL Tables

This is a rough SQL-style sketch.

Use JSONB for flexible policy fields.

### users

- id text primary key
- email text not null
- display_name text
- created_at timestamptz not null
- updated_at timestamptz not null

### aegis_ids

- id text primary key
- type text not null
- user_id text references users(id)
- display_name text
- status text not null
- metadata jsonb not null default '{}'
- created_at timestamptz not null
- updated_at timestamptz not null

### collars

- id text primary key
- user_id text references users(id)
- name text not null
- description text
- purpose text
- status text not null
- allowed_actions jsonb not null default '[]'
- approval_required_actions jsonb not null default '[]'
- blocked_actions jsonb not null default '[]'
- spending_limits jsonb not null default '{}'
- identity_claim_rules jsonb not null default '{}'
- credential_rules jsonb not null default '{}'
- counterparty_rules jsonb not null default '{}'
- file_rules jsonb not null default '{}'
- messaging_rules jsonb not null default '{}'
- session_limits jsonb not null default '{}'
- receipt_settings jsonb not null default '{}'
- created_at timestamptz not null
- updated_at timestamptz not null
- revoked_at timestamptz

### aegis_passes

- id text primary key
- user_id text references users(id)
- token_hash text not null
- agent_name text not null
- purpose text
- default_collar_id text references collars(id)
- allowed_collar_ids jsonb not null default '[]'
- status text not null
- expires_at timestamptz
- last_used_at timestamptz
- created_at timestamptz not null
- updated_at timestamptz not null
- revoked_at timestamptz

### protected_sessions

- id text primary key
- user_id text references users(id)
- aegis_pass_id text references aegis_passes(id)
- collar_id text references collars(id)
- agent_session_aegis_id text references aegis_ids(id)
- status text not null
- mode text not null
- current_url text
- current_domain text
- browser_context_id text
- browser_page_id text
- created_at timestamptz not null
- updated_at timestamptz not null
- expires_at timestamptz
- paused_at timestamptz
- closed_at timestamptz
- revoked_at timestamptz

### approval_requests

- id text primary key
- user_id text references users(id)
- session_id text references protected_sessions(id)
- collar_id text references collars(id)
- action_type text not null
- risk_level text not null
- domain text
- summary text
- reason text
- context jsonb not null default '{}'
- status text not null
- requested_by text
- resolved_by text
- created_at timestamptz not null
- resolved_at timestamptz
- expires_at timestamptz

### runner_tasks

- id text primary key
- user_id text references users(id)
- session_id text references protected_sessions(id)
- approval_request_id text references approval_requests(id)
- collar_id text references collars(id)
- task_type text not null
- status text not null
- domain text
- constraints jsonb not null default '{}'
- result jsonb not null default '{}'
- created_at timestamptz not null
- started_at timestamptz
- completed_at timestamptz
- expires_at timestamptz

### receipts

- id text primary key
- user_id text references users(id)
- session_id text references protected_sessions(id)
- collar_id text references collars(id)
- aegis_pass_id text references aegis_passes(id)
- action_type text not null
- decision text not null
- domain text
- counterparty_trust_status text
- reason text
- outcome text
- sensitive_data_shared_with_agent boolean not null default false
- receipt_detail_level text not null default 'minimal'
- metadata jsonb not null default '{}'
- created_at timestamptz not null

### reputation_events

- id text primary key
- entity_type text not null
- entity_id text not null
- event_type text not null
- category text
- severity text not null
- session_id text references protected_sessions(id)
- receipt_id text references receipts(id)
- domain text
- weight numeric
- metadata jsonb not null default '{}'
- created_at timestamptz not null

### domain_trust_records

- id text primary key
- domain text not null unique
- domain_verified boolean not null default false
- business_verified boolean not null default false
- business_aegis_id text
- trust_label text not null default 'unknown'
- known_prompt_injection_reports integer not null default 0
- known_dispute_count integer not null default 0
- metadata jsonb not null default '{}'
- created_at timestamptz not null
- updated_at timestamptz not null

### incident_reports

- id text primary key
- user_id text references users(id)
- session_id text references protected_sessions(id)
- receipt_id text references receipts(id)
- domain text
- incident_type text not null
- severity text not null
- description text
- status text not null
- metadata jsonb not null default '{}'
- created_at timestamptz not null
- resolved_at timestamptz

## MVP Minimal Schema

If speed matters, start with only:

- users
- collars
- aegis_passes
- protected_sessions
- approval_requests
- receipts
- reputation_events
- domain_trust_records

Add:

- runner_tasks
- incident_reports
- aegis_ids

when needed.

## Data Retention

For MVP, data retention can be simple.

Long-term principles:

- short-lived sessions should expire
- old browser context data should be deleted
- receipts may be kept longer
- sensitive metadata should be minimized
- screenshots should be opt-in or high-risk only
- incident reports should have review and resolution status

## Privacy Notes

Avoid storing:

- raw passwords
- raw cards
- full IDs
- full documents
- full page contents
- full browser history
- full LLM transcripts
- private message contents
- unnecessary screenshots

Prefer storing:

- action type
- collar ID
- decision
- domain
- trust status
- approval status
- outcome
- timestamp
- receipt ID

Core line:

> Store trust-relevant receipts, not surveillance.

## Core Lines To Preserve

- Agents are disposable. Trust is not.
- The pass is access. The collar is policy.
- Collars are customizable first. Templates are only starting points.
- Agents can browse. Aegis decides when they can commit.
- Aegis turns secrets into controlled capabilities.
- Receipts record trust-relevant events, not everything.
- Reputation should attach to durable AegisID, not disposable agent instances.


