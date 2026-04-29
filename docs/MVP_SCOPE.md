# MVP_SCOPE.md

## Purpose

This document defines the first buildable version of Aegis.

The goal of the MVP is not to build the full Aegis vision. The goal is to prove the core loop:

> An outside agent can browse freely through an Aegis-controlled session, but Aegis gates sensitive actions through collars, approvals, temporary execution, and receipts.

The MVP should make the product feel real without trying to solve every future use case.

## Core MVP Thesis

Aegis is not an agent builder.

Aegis is the trust and control layer users attach to agents built anywhere.

The MVP should prove that an outside agent can be given an Aegis Pass, request a protected browser session, act on the web, and be stopped or approved when it tries to cross a sensitive boundary.

Core line:

> Agents can browse. Aegis decides when they can commit.

## Primary MVP Demo

The first demo should use a Shopping Collar.

Shopping is easy to understand because the risk boundaries are obvious:

- browsing is fine
- comparing is fine
- adding to cart is usually fine
- checkout is sensitive
- payment is sensitive
- subscriptions are risky
- unverified merchants are risky
- identity disclosure is risky

The demo should show:

1. A user creates an Aegis Pass.
2. The user attaches a Shopping Collar.
3. An outside agent requests an Aegis Protected Session.
4. Aegis launches a controlled browser session.
5. The agent browses normally.
6. The agent finds a product.
7. The agent adds the product to cart.
8. The agent reaches checkout.
9. Aegis detects the sensitive action.
10. Aegis checks the Shopping Collar.
11. Aegis asks the user for approval.
12. If approved, an Aegis Runner completes the sensitive step.
13. Aegis creates a receipt.
14. Aegis records a basic reputation signal.

## MVP User Story

As a user, I want to let an AI agent shop for me without giving it my password, credit card, or unrestricted browser access.

I want the agent to browse and compare freely, but I want Aegis to stop it before it buys, logs in, shares personal information, or interacts with suspicious websites.

## MVP Product Flow

### 1. User creates an Aegis Pass

The user starts by securing a new outside agent.

They should be able to define:

- agent name
- task purpose
- collar type
- expiration
- approval settings

Example object:

{
  "agent_name": "Shopping Agent",
  "purpose": "Find running shoes under $100",
  "collar": "shopping",
  "expires_in_minutes": 120
}

The Aegis Pass should not contain raw credentials.

It should allow the agent to request controlled capabilities from Aegis.

### 2. User attaches a Shopping Collar

The Shopping Collar should include simple default rules.

Allowed:

- browse websites
- search products
- compare options
- read reviews
- add item to cart

Approval required:

- login
- purchase
- payment
- share email
- share phone number
- create account
- use verified student claim
- submit shipping address

Blocked:

- save payment method
- buy subscription
- purchase from unverified merchant
- upload government ID
- share sensitive identity documents
- access unrelated accounts

### 3. Agent requests a protected browser session

The outside agent should be able to request a browser session through an Aegis tool, MCP endpoint, API, or local bridge.

Example request:

{
  "action": "create_protected_session",
  "agent_pass": "pass_123",
  "purpose": "Find running shoes under $100",
  "requested_collar": "shopping"
}

Aegis should decide whether to create the session and which collar applies.

The agent should not get unrestricted browser access.

### 4. Aegis launches a protected browser session

The protected session should be:

- controlled by Aegis
- collar-bound
- isolated from the user’s normal browser
- short-lived
- able to run headless by default
- viewable on demand
- monitored for sensitive action boundaries

Recommended technical direction:

- Playwright-controlled Chromium
- isolated browser context
- event hooks for navigation, clicks, forms, fields, and network requests
- policy checks before sensitive actions

### 5. Agent browses freely

The agent should be able to perform low-risk activity without approval:

- navigate to websites
- scroll
- search
- compare products
- read reviews
- open product pages
- summarize findings
- add to cart

Aegis should not interrupt every click.

The MVP should avoid creating an annoying approval flow.

### 6. Aegis detects sensitive action boundaries

Aegis should detect common sensitive actions.

Initial detection targets:

- login pages
- password fields
- checkout pages
- payment fields
- credit card fields
- “place order” buttons
- subscription language
- form submissions
- file uploads
- email/phone/address fields
- suspicious or unverified domains

Detection can begin with simple rules.

Examples:

- input[type="password"]
- input[autocomplete="cc-number"]
- button text includes “Place Order”
- URL contains /checkout
- form includes credit card or address fields
- file upload input appears
- submit button near payment language

Advanced classification can come later.

### 7. Aegis checks the collar

When a sensitive boundary is detected, Aegis checks:

- the active collar
- the requested action
- the website/domain
- whether the business is verified or unverified
- whether user approval is required
- whether the action is blocked
- whether the session has expired

Example decision:

{
  "decision": "approval_required",
  "reason": "Shopping Collar requires approval before purchase.",
  "action_type": "purchase",
  "risk_level": "high"
}

### 8. Aegis approval inbox

If an action requires approval, Aegis should pause the protected session and ask the user.

Example approval card:

Your Shopping Agent wants to purchase running shoes for $89.99.

Merchant: Nike  
Website: nike.com  
Collar: Shopping  
Reason: Purchases require approval.

Approve / Deny / View Session

The user should be able to:

- approve once
- deny once
- block site
- pause agent
- view session

For MVP, keep the approval inbox simple.

A web UI is enough. A mobile app can come later.

### 9. Aegis Runner completes the sensitive step

If the user approves, Aegis should hand the sensitive action to an Aegis Runner.

For MVP, the Runner can be simulated or partially implemented.

The Runner should represent the idea that:

> The outside agent does not receive the raw secret. Aegis performs the sensitive step.

Examples:

- fill payment field from mock vault
- submit approved checkout in a mock store
- disclose a mock verified student claim
- fill login credentials in a demo website
- publish approved text in a mock social app

The Runner should be:

- short-lived
- scoped to one action
- logged
- terminated after execution

### 10. Receipt is created

Every sensitive action should create a receipt.

The receipt should include:

- receipt ID
- agent session ID
- collar used
- action type
- decision
- approval status
- counterparty domain
- timestamp
- result
- whether sensitive data was shared
- whether a dispute or incident occurred

Example receipt:

{
  "receipt_id": "rec_123",
  "agent_session_id": "sess_456",
  "collar": "shopping",
  "action_type": "purchase",
  "decision": "approved_by_user",
  "counterparty_domain": "nike.com",
  "amount_bucket": "50_to_100",
  "sensitive_data_shared": false,
  "timestamp": "2026-04-26T22:14:00Z",
  "outcome": "completed"
}

The receipt should avoid storing unnecessary private details.

### 11. Basic reputation signal updates

The MVP should not build a full reputation graph.

It should only record basic trust signals:

- protected session created
- sensitive action requested
- action approved
- action denied
- action blocked
- receipt created
- user marked action successful
- user reported issue
- unverified website attempted sensitive action

Display simple metrics:

- sessions protected
- sensitive actions approved
- risky actions blocked
- receipts created
- disputes reported

## MVP Components

### Required

The MVP should include:

- basic user account
- Aegis Pass creation
- Shopping Collar preset
- protected browser session creation
- Playwright/Chromium session controller
- simple sensitive action detector
- policy decision engine
- approval inbox
- receipt log
- basic reputation event log

### Optional but Valuable

If time allows:

- visible browser preview
- headless mode
- mock vault
- mock payment runner
- mock verified student claim
- mock verified business badge
- prompt injection report button
- session expiration and revocation

### Not Required

Do not build these in the MVP:

- full password manager
- real credit card handling
- real government ID verification
- full OAuth ecosystem
- full business verification
- full website trust graph
- real insurance or guarantees
- family controls
- elder protection
- enterprise admin console
- agent marketplace
- public reputation scores

## MVP Data Models

### User

{
  "id": "user_123",
  "email": "user@example.com",
  "created_at": "2026-04-26T00:00:00Z"
}

### Aegis Pass

{
  "id": "pass_123",
  "user_id": "user_123",
  "agent_name": "Shopping Agent",
  "default_collar": "shopping",
  "status": "active",
  "expires_at": "2026-04-27T00:00:00Z",
  "created_at": "2026-04-26T00:00:00Z"
}

### Collar

{
  "id": "collar_123",
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

### Protected Session

{
  "id": "sess_123",
  "user_id": "user_123",
  "agent_pass_id": "pass_123",
  "collar_id": "collar_123",
  "status": "active",
  "current_url": "https://example.com",
  "mode": "headless",
  "created_at": "2026-04-26T00:00:00Z",
  "expires_at": "2026-04-26T02:00:00Z"
}

### Approval Request

{
  "id": "approval_123",
  "session_id": "sess_123",
  "action_type": "purchase",
  "risk_level": "high",
  "domain": "nike.com",
  "summary": "Purchase running shoes for $89.99",
  "status": "pending",
  "created_at": "2026-04-26T01:00:00Z"
}

### Receipt

{
  "id": "rec_123",
  "session_id": "sess_123",
  "collar_type": "shopping",
  "action_type": "purchase",
  "decision": "approved_by_user",
  "domain": "nike.com",
  "outcome": "completed",
  "created_at": "2026-04-26T01:05:00Z"
}

## MVP User Interface

The MVP UI should be simple.

### Main Screens

1. Dashboard
2. Create Aegis Pass
3. Collar Details
4. Active Sessions
5. Approval Inbox
6. Receipts

### Dashboard

Show:

- active agents
- active protected sessions
- pending approvals
- recent blocked actions
- recent receipts

### Create Aegis Pass

Inputs:

- agent name
- task purpose
- collar selection
- expiration

Output:

- Agent Pass token or setup instruction
- connected protected session option

### Collar Details

Show:

- allowed actions
- approval-required actions
- blocked actions

### Active Session

Show:

- agent name
- collar
- current website
- status
- recent activity
- view session button if available
- pause/revoke button

### Approval Inbox

Show pending sensitive actions.

Each approval should include:

- what the agent wants to do
- website/domain
- collar rule
- risk reason
- approve/deny buttons

### Receipts

Show trust-relevant completed events.

Avoid exposing unnecessary private details.

## MVP Technical Direction

### Browser Control

Use Playwright with Chromium.

The protected session should use a separate browser context, not the user’s normal browser profile.

The session should be isolated and disposable.

### Detection

Start with rule-based detection.

Initial signals:

- URL patterns
- input types
- form labels
- button text
- nearby page text
- network request method
- outgoing form data categories

Do not overbuild AI classification in the first version.

### Policy Engine

Implement a simple policy function:

evaluateAction({
  collar,
  actionType,
  domain,
  context
}) -> {
  decision: "allow" | "approval_required" | "block",
  reason: string
}

### Approval Flow

When approval is required:

1. pause the browser action
2. create approval request
3. wait for user response
4. continue or abort action
5. create receipt

### Receipts

Receipts should be append-only in spirit, even if stored simply in the MVP.

Every sensitive decision should create a durable record.

## Definition of Done

The MVP is done when the following demo works:

1. User creates a Shopping Collar.
2. User creates an Aegis Pass for an outside shopping agent.
3. Agent requests a protected session.
4. Aegis launches a browser session.
5. Agent browses a shopping website.
6. Agent adds an item to cart.
7. Agent attempts checkout.
8. Aegis detects checkout/payment.
9. Aegis pauses the session.
10. User receives approval request.
11. User approves or denies.
12. If approved, Aegis Runner completes or simulates completion.
13. Receipt appears.
14. Dashboard updates basic trust signals.

## Future Expansions

After the MVP, possible next steps include:

- Email Collar
- Social Collar
- Travel Collar
- verified student claims
- verified employee claims
- real OAuth integrations
- real payment controls
- business AegisID
- website AegisID
- prompt injection reporting
- family controls
- elder protection mode
- mobile approval inbox
- reputation graph
- agent platform integrations

## Core Lines To Preserve

- Agents are disposable. Trust is not.
- Aegis is the collar you put on AI agents before letting them act for you.
- Do not give your agent your password. Give it an Aegis Pass.
- Agents can browse. Aegis decides when they can commit.
- Outside agents plan. Aegis executes sensitive steps.
- Aegis turns secrets into controlled capabilities.
- Aegis reputation is a history of how safely your agents act under verified delegation.

