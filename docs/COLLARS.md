# COLLARS.md

## Purpose

This document defines Aegis Collars.

Collars are the core permission and restriction primitive in Aegis.

A collar is a customizable policy object that users attach to outside agents. It defines what an agent can do, what it cannot do, what requires approval, what identity claims it can use, what credentials it can request, which websites or businesses it can interact with, and when its authority expires.

Aegis does not create agents.

Aegis gives users a way to place enforceable boundaries around agents built anywhere.

Core line:

> Aegis is the collar you put on an AI agent before letting it act for you.

## Core Concept

A collar is not a prompt.

A collar is not a markdown instruction file.

A collar is not just a suggestion for the agent to follow.

A collar should become a signed, revocable, enforceable permission object that Aegis uses to govern agent action.

The agent can think, browse, plan, and draft.

Aegis checks the collar when the agent tries to do something sensitive.

Core line:

> Agents can browse. Aegis decides when they can commit.

## Customization First

Collars should be fully customizable.

Aegis may offer example templates such as Shopping, Travel, Email, Social, Finance, Student, Family, or Elder Protection collars, but these are only starting points.

Users should be able to create custom collars from scratch.

Users should be able to decide:

- what actions are allowed
- what actions are blocked
- what actions require approval
- what websites are trusted
- what websites are blocked
- what identity claims can be used
- what credentials can be requested
- what payment limits apply
- what data can be shared
- what files can be uploaded
- what accounts can be accessed
- what time limits apply
- what risk level should trigger approval
- whether a trusted contact or guardian must approve certain actions

The product should make customization simple for normal users while still allowing advanced users to define detailed rules.

## Presets Are Templates, Not Limits

Aegis can offer collar templates to help users start quickly.

Example templates:

- Shopping
- Travel
- Email
- Social
- Finance
- Student
- Family
- Elder Protection
- Work
- Research
- Developer
- Custom

However, users should always be able to edit these templates.

A Shopping Collar is not a hardcoded product category. It is just an example of a policy bundle.

The real product is the customizable collar system.

## What A Collar Controls

A collar can control several categories of agent behavior.

### 1. Browser access

A collar can define whether the agent can:

- open websites
- browse freely
- scroll feeds
- search the web
- click links
- use protected browser sessions
- access specific domains
- access specific site categories

Aegis should generally allow low-risk browsing.

The collar should focus on restricting sensitive commitments, not normal browsing.

### 2. Login access

A collar can define when the agent can request login.

Examples:

- allow login only to approved websites
- require approval for every login
- block login to finance sites
- allow login to school portal only during task window
- allow Aegis Runner to log in without revealing password
- block raw password exposure to the agent

### 3. Payment and purchase access

A collar can define:

- whether purchases are allowed
- whether purchases require approval
- maximum purchase amount
- daily spending limit
- merchant restrictions
- subscription restrictions
- refundability requirements
- whether virtual cards must be used
- whether payment info can be saved
- whether unverified merchants are blocked

Example rules:

- purchases under $25 from verified merchants are allowed
- purchases $25 to $100 require approval
- purchases over $100 are blocked
- subscriptions are blocked
- saving payment methods is blocked
- purchases from unverified merchants require approval or are blocked

### 4. Identity claim access

A collar can define what verified claims an agent can use.

Examples:

- verified human
- verified student
- verified employee
- verified adult
- verified guardian
- verified business owner
- verified local resident
- verified veteran
- verified professional license holder

A collar should also define disclosure limits.

For example:

- allow proving verified student
- block sharing student ID number
- allow proving over 18
- block sharing full date of birth
- allow proving employee status
- block sharing company internal information
- allow legal name disclosure only with approval

Core line:

> Aegis gives agents usable identity without exposing unnecessary identity.

### 5. Messaging and publishing access

A collar can define whether an agent can:

- draft messages
- send messages
- comment
- post publicly
- reply to DMs
- message new people
- email known contacts
- email new contacts
- attach files
- publish on behalf of the user

Example rules:

- drafting is allowed
- posting requires approval
- DMs to new people require approval
- mass messaging is blocked
- sending attachments requires approval
- public posts on sensitive topics require approval
- impersonation is blocked

### 6. File and document access

A collar can define what files an agent can access or upload.

Examples:

- allow reading selected folder
- block access to tax documents
- block access to medical records
- require approval before uploading any file
- allow resume upload to verified job sites
- block government ID upload
- require guardian approval for school or child-related documents

### 7. Form submission access

A collar can define whether an agent can submit forms.

Examples:

- allow search forms
- allow harmless filters
- require approval for applications
- require approval for reservations
- require approval for legal forms
- require approval for healthcare forms
- block forms requesting SSN
- block forms on unverified websites

### 8. Account settings access

A collar can define whether an agent can change account settings.

Examples:

- block password changes
- block email changes
- block 2FA changes
- block deleting accounts
- require approval for subscription changes
- require approval for privacy setting changes
- require approval for connecting new apps

### 9. Website and business trust

A collar can define counterparty requirements.

Examples:

- allow sensitive actions only on verified websites
- allow payments only to verified businesses
- block identity disclosure to unverified domains
- require approval for new merchants
- block sites with prompt injection reports
- block businesses with high dispute rates
- allow browsing unverified sites but block checkout

### 10. Time and session limits

A collar can define:

- expiration time
- maximum session duration
- allowed time of day
- number of active sessions
- maximum number of sensitive requests
- cooldown periods after denial
- temporary lockdown after suspicious activity

### 11. Approval rules

A collar can define when approval is required.

Approval can come from:

- the user
- a parent or guardian
- a trusted contact
- an enterprise admin
- multiple approvers for high-risk actions

Example rules:

- user approval required for purchases
- guardian approval required for child account messages
- trusted contact approval required for elder financial actions
- two approvals required for wire transfer or legal document submission

### 12. Escalation and emergency controls

A collar can define what happens when something suspicious occurs.

Examples:

- pause session
- revoke collar
- notify user
- notify guardian
- block website
- report incident
- require reauthentication
- switch to strict mode
- terminate protected session

## Collar Decisions

When an agent attempts an action, Aegis should classify the action and evaluate it against the collar.

Possible decisions:

- allow
- allow and log
- approval_required
- runner_required
- block
- pause_session
- revoke_session
- escalate_to_guardian
- report_incident

The decision should be explainable.

Example:

“Blocked because this collar does not allow subscriptions.”

Example:

“Approval required because this website is unverified and the agent is attempting to share your phone number.”

Example:

“Allowed because browsing product pages is permitted under this collar.”

## Collar Structure

A collar should eventually include:

- collar ID
- owner AegisID
- agent session ID
- name
- description
- purpose
- allowed actions
- approval-required actions
- blocked actions
- identity claim permissions
- credential permissions
- website trust requirements
- spending limits
- file access rules
- messaging rules
- session limits
- expiration
- revocation status
- signing metadata
- receipt requirements

Example collar object:

{
  "id": "collar_123",
  "name": "Custom Shopping Collar",
  "owner_aegis_id": "aid_user_123",
  "agent_session_id": "aid_session_456",
  "purpose": "Find and optionally buy running shoes under strict payment limits",
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
    "submit_shipping_address"
  ],
  "blocked_actions": [
    "save_payment_method",
    "buy_subscription",
    "upload_government_id",
    "share_sensitive_identity"
  ],
  "identity_claims": {
    "verified_student": {
      "allowed": true,
      "requires_approval": true,
      "disclosure": "claim_only"
    },
    "verified_adult": {
      "allowed": false
    }
  },
  "counterparty_rules": {
    "sensitive_actions_require_verified_business": true,
    "block_prompt_injection_reported_sites": true
  },
  "spending_limits": {
    "max_without_approval": 0,
    "max_with_approval": 100,
    "subscriptions_allowed": false
  },
  "session_limits": {
    "expires_at": "2026-04-27T00:00:00Z",
    "max_duration_minutes": 120
  },
  "status": "active"
}

## Policy Categories

Aegis should separate actions into risk categories.

### Low-risk actions

Usually allowed.

Examples:

- browse
- scroll
- search
- read
- compare
- summarize
- open product pages
- draft text

### Medium-risk actions

May be allowed or logged depending on the collar.

Examples:

- add to cart
- fill non-sensitive form fields
- save draft
- hold refundable reservation
- use low-risk verified claim
- message known contact as draft only

### High-risk actions

Usually require approval.

Examples:

- purchase
- payment
- send email
- post publicly
- message new contact
- submit application
- upload file
- disclose phone or address
- create account
- book reservation with fee

### Critical-risk actions

Usually blocked or require strict approval.

Examples:

- upload government ID
- share SSN
- submit medical information
- transfer money
- trade assets
- sign legal documents
- delete account
- change password
- turn off 2FA
- post from brand account
- message minors or strangers in sensitive contexts
- buy subscription
- purchase from unverified merchant

## Custom Rule Builder

Long-term, Aegis should support a simple rule builder.

Users should be able to create rules like:

- If action is purchase and amount is greater than $50, require approval.
- If website is unverified and action includes identity disclosure, block.
- If action is post_publicly, require approval.
- If action is browse, allow.
- If action is upload_file and file type is government_id, block.
- If user is in elder mode and action is payment, notify trusted contact.
- If business has high dispute rate, require approval.
- If prompt injection is detected, pause session.

The UI should hide complexity but preserve power.

Normal users should use simple toggles.

Advanced users should be able to configure granular rules.

## Example Rule Format

A future rule may look like:

{
  "id": "rule_001",
  "name": "Require approval for purchases over $50",
  "if": {
    "action_type": "purchase",
    "amount_greater_than": 50
  },
  "then": {
    "decision": "approval_required"
  }
}

Another example:

{
  "id": "rule_002",
  "name": "Block identity disclosure to unverified websites",
  "if": {
    "action_type": "identity_disclosure",
    "counterparty_verified": false
  },
  "then": {
    "decision": "block"
  }
}

Another example:

{
  "id": "rule_003",
  "name": "Allow browsing by default",
  "if": {
    "action_type": "browse"
  },
  "then": {
    "decision": "allow"
  }
}

## Collar Templates

Aegis can offer templates to reduce friction.

Templates should be editable.

Templates should never prevent users from building custom collars.

### Example: Shopping Template

Default behavior:

- allow browsing
- allow comparing
- allow adding to cart
- require approval for purchase
- require approval for payment
- block subscriptions
- block government ID upload
- restrict unverified merchants

### Example: Social Template

Default behavior:

- allow browsing feeds
- allow drafting posts
- require approval for posting
- require approval for DMs
- block mass messaging
- block impersonation

### Example: Email Template

Default behavior:

- allow reading selected inbox scope
- allow drafting replies
- require approval before sending
- require approval before forwarding
- block sending sensitive files

### Example: Travel Template

Default behavior:

- allow search and comparison
- allow refundable holds
- require approval for payment
- require approval for passport disclosure
- block non-refundable booking without approval

### Example: Finance Template

Default behavior:

- allow reading summaries
- allow categorization
- block transfers
- block trades
- block account setting changes
- require strict approval for any financial action

### Example: Family Template

Default behavior:

- restrict purchases
- restrict messaging strangers
- require guardian approval for sensitive actions
- block adult content
- block identity disclosure

### Example: Elder Protection Template

Default behavior:

- require trusted contact approval for payments
- block gift card purchases
- block wire transfers
- warn on suspicious urgency
- block unverified businesses
- protect medical and financial data

## Collar Lifecycle

### 1. Create

The user creates a new collar or starts from a template.

### 2. Configure

The user defines allowed, blocked, and approval-required actions.

### 3. Attach

The collar is attached to an agent session or Aegis Pass.

### 4. Enforce

Aegis enforces the collar through protected sessions, tool gateways, approval flows, and runners.

### 5. Update

The user can edit the collar.

Edits should apply to future actions.

For sensitive changes, Aegis may require reauthorization.

### 6. Revoke

The user can revoke the collar at any time.

A revoked collar should immediately block further sensitive actions.

### 7. Expire

Collars should support expiration.

Short-lived collars are safer for high-risk tasks.

### 8. Archive

Completed collars can be archived with receipts for accountability.

## Signing and Revocation

Eventually, collars should be signed and verifiable.

A signed collar proves:

- Aegis issued or validated it
- the user authorized it
- the policy has not been tampered with
- the collar is tied to a specific session or pass
- the collar has not expired
- the collar has not been revoked

The agent may carry the collar, but Aegis signs and verifies it.

Core line:

> The agent carries the collar. Aegis defines what the collar means.

For MVP, signing can be deferred if the collar is only evaluated server-side.

However, the architecture should assume collars eventually become signed, revocable, portable policy credentials.

## Enforcement Points

A collar is only meaningful if enforced.

Aegis can enforce collars through:

- protected browser sessions
- MCP gateways
- API gateways
- OAuth/token brokers
- Aegis Runners
- approval inbox
- website or business AegisID integrations
- future browser extensions
- future agent platform integrations

The collar should not depend on the agent voluntarily obeying.

The collar should be checked by systems that control access to actions, credentials, sessions, tools, or sensitive data.

## Relationship To Aegis Pass

An Aegis Pass lets an outside agent request access to Aegis-controlled capabilities.

A collar defines what the agent can do once it has that pass.

Example:

- Aegis Pass: this agent can request Aegis services.
- Collar: this agent may browse and add to cart, but purchase requires approval.

The pass is access.

The collar is policy.

## Relationship To AegisID

AegisID is durable.

Collars are temporary or task-specific.

A user may have one AegisID and many collars.

A collar can use verified claims from the user’s AegisID, but it should only disclose claims allowed by the collar.

Example:

The user’s AegisID may include verified student, verified adult, and verified employee.

A specific collar may allow only verified student, block verified employee, and require approval for verified adult.

## Relationship To Reputation

Collars create the context for reputation.

A receipt is only meaningful if it records the collar active at the time.

Reputation signals should answer:

- Did the agent stay within the collar?
- Did the user approve the sensitive action?
- Did the business honor the policy?
- Did the session trigger incidents?
- Did the agent attempt to bypass restrictions?
- Did the action complete successfully?

Reputation should be tied to verified delegation, not random raw activity.

## MVP Collar Requirements

For the MVP, collars should support:

- name
- type
- purpose
- allowed actions
- approval-required actions
- blocked actions
- expiration
- session binding
- basic spending limit
- basic counterparty requirement
- receipt settings

The first MVP collar can be a customizable Shopping-like collar, but the system should not hardcode shopping as the only possible use case.

Even if the UI starts with a Shopping template, the backend should treat collars generically.

## MVP Implementation Guidance

Build collars as generic policy objects.

Avoid hardcoding product-specific logic like:

- if shopping then...
- if travel then...
- if social then...

Instead, use action types and rule evaluation.

Good:

- action_type = purchase
- action_type = post_publicly
- action_type = login
- action_type = upload_file
- action_type = identity_disclosure
- action_type = browse

Bad:

- shoppingAgentCanBuy
- socialAgentCanPost
- travelAgentCanBook

This keeps the collar system flexible.

## Action Type Registry

Aegis should maintain a registry of action types.

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

This registry should grow over time.

## User Experience

The collar UI should support two modes.

### Simple Mode

For normal users.

Use plain language:

- Can browse websites
- Can add items to cart
- Ask me before buying
- Never save my payment method
- Ask me before posting
- Never upload my ID
- Only use verified student status with approval

### Advanced Mode

For power users.

Allow detailed rules:

- action type
- website category
- counterparty trust
- amount thresholds
- claim disclosure rules
- approval routing
- expiration
- logging level
- trusted contacts

The same collar engine should power both modes.

## Privacy

Collars should minimize unnecessary data sharing.

A collar should not reveal all user identity claims by default.

A collar should only reveal:

- the claim needed
- to the counterparty allowed
- for the task allowed
- at the risk level allowed

Example:

If a website only needs to know the user is a student, the collar should not reveal legal name, birthdate, student number, or school records unless necessary and approved.

## Safety

When uncertain, Aegis should prefer requiring approval over silently allowing sensitive actions.

However, Aegis should avoid excessive approvals for low-risk browsing and planning.

The product should feel like:

> Set the boundaries once. Aegis only interrupts when the agent crosses them.

## Core Lines To Preserve

- A collar is not a prompt. It is an enforceable policy boundary.
- Collars should be customizable first. Templates are only starting points.
- Agents can browse. Aegis decides when they can commit.
- The pass is access. The collar is policy.
- Aegis gives agents usable identity without exposing unnecessary identity.
- The agent carries the collar. Aegis defines what the collar means.
- Aegis reputation is built from how safely agents act under collars.

