# UX_SPEC.md

## Purpose

This document defines the user experience for the Aegis MVP.

The goal is to make Aegis feel simple, powerful, and trustworthy.

Aegis should not feel like an enterprise security console.

Aegis should not feel like a password manager.

Aegis should not feel like an agent builder.

Aegis should feel like the place users go to secure agents built anywhere.

Core line:

> Aegis is the collar you put on AI agents before letting them act for you.

## UX Thesis

Most users do not want to inspect every agent action.

Most users do not want to configure a complex policy engine.

Most users do not want constant approval popups.

Users want peace of mind.

Aegis should let users:

1. Create or choose a collar.
2. Attach it to an outside agent.
3. Let the agent work.
4. Get notified only when something sensitive happens.
5. Approve, deny, pause, or revoke quickly.
6. See simple receipts afterward.

Core line:

> Set the boundaries once. Aegis only interrupts when the agent crosses them.

## Product Feel

Aegis should feel:

- calm
- trustworthy
- premium
- protective
- clear
- powerful but simple
- transparent but not overwhelming

Aegis should not feel:

- paranoid
- noisy
- technical-first
- enterprise-heavy
- like a firewall dashboard from 2008
- like a generic password manager
- like a browser automation toy
- like a surveillance feed

## Primary User Flow

The first MVP flow should be:

1. User opens Aegis.
2. User clicks “Secure a New Agent.”
3. User names the agent.
4. User describes what the agent will do.
5. User creates or customizes a collar.
6. Aegis creates an Aegis Pass.
7. User gives the pass to an outside agent or starts a protected session.
8. Agent requests protected web access.
9. Aegis shows live session status.
10. Agent browses freely.
11. Sensitive action is detected.
12. Approval request appears.
13. User approves or denies.
14. Aegis creates receipt.
15. Dashboard updates trust signals.

## Main Screens

The MVP should have six main screens:

1. Dashboard
2. Secure a New Agent
3. Collar Editor
4. Active Session
5. Approval Inbox
6. Receipts

Optional later screens:

- AegisID
- Verified Claims
- Business Trust
- Reputation
- Settings
- Trusted Contacts
- Vault

## Screen 1: Dashboard

### Purpose

The dashboard gives the user a quick sense that their agents are under control.

It should not show too much detail.

It should answer:

- Which agents are active?
- Are any approvals waiting?
- Were any risky actions blocked?
- What happened recently?
- Is everything okay?

### Key Sections

#### Status Summary

Example:

Your agents are protected.

- 2 active sessions
- 1 approval waiting
- 3 risky actions blocked this week
- 8 receipts created
- 0 issues reported

#### Active Agents

Show cards for active protected sessions.

Each card:

- agent name
- collar name
- current website
- status
- current action summary
- pause button
- view session button

Example:

Shopping Agent  
Collar: Custom Shopping Collar  
Status: Browsing  
Current site: example-store.com  
Last action: Added item to cart

#### Pending Approvals

Show the most important pending approvals.

Example:

Shopping Agent wants to purchase running shoes for $89.99.

Approve / Deny / View

#### Recent Activity

Show trust-relevant events only.

Examples:

- Shopping Agent started protected session.
- Aegis blocked subscription checkout.
- User approved purchase request.
- Receipt created for approved action.

Do not show every click or page.

### Dashboard Copy

Headline:

> Your agents are protected.

Subheadline:

> Aegis watches for sensitive actions so your agents can work without holding your secrets.

Primary CTA:

> Secure a New Agent

Secondary CTA:

> View Approvals

## Screen 2: Secure a New Agent

### Purpose

This screen creates an Aegis Pass for an outside agent.

It should make clear that Aegis is not creating the agent.

Aegis is securing an agent that exists elsewhere.

### Fields

- Agent name
- What will this agent do?
- Collar selection
- Expiration
- Session mode
- Create pass button

### Suggested Labels

Agent name:

> What should we call this agent?

Task purpose:

> What are you letting this agent do?

Collar:

> Choose or create a collar

Expiration:

> How long should this agent have access?

Session mode:

> Protected browser mode

Options:

- Headless
- Visible
- Ask each time

### Copy

Header:

> Secure a New Agent

Description:

> Create an Aegis Pass for an agent built anywhere. The pass lets the agent request protected access without receiving your raw passwords, payment info, or identity documents.

Important note:

> Aegis does not create the agent. Aegis controls what the agent can do.

### After Creation

Show:

- pass created
- collar attached
- expiration
- setup instructions

Example:

Aegis Pass created.

Agent: Shopping Agent  
Collar: Custom Shopping Collar  
Expires: 2 hours

Setup options:

- Copy Agent Pass
- Copy MCP endpoint
- Start protected session
- View instructions

### Pass Safety Copy

> This pass does not contain your passwords, cards, or identity documents. It only lets the agent request controlled capabilities from Aegis.

## Screen 3: Collar Editor

### Purpose

The Collar Editor lets users define exactly what an agent can do.

Collars should be fully customizable.

Templates are only starting points.

### UX Principle

The editor should support both simple and advanced users.

Normal users should see clear toggles.

Advanced users should be able to define detailed rules.

### Simple Mode Sections

#### Allowed

Actions the agent can do automatically.

Examples:

- Browse websites
- Search
- Read pages
- Compare options
- Add items to cart
- Draft messages

#### Ask Me First

Actions that require approval.

Examples:

- Login
- Purchase
- Payment
- Share email
- Share phone number
- Submit forms
- Post publicly
- Send messages
- Upload files

#### Never Allow

Actions that are blocked.

Examples:

- Buy subscriptions
- Save payment method
- Upload government ID
- Share sensitive identity documents
- Change account settings
- Delete accounts

### Advanced Mode Sections

Advanced mode can include:

- action type rules
- amount thresholds
- website trust requirements
- identity claim permissions
- file rules
- messaging rules
- approval routing
- expiration
- logging detail level

### Collar Editor Copy

Header:

> Customize Collar

Description:

> Define what this agent can do, what requires approval, and what is never allowed.

Clarifying line:

> Collars are fully customizable. Templates are only starting points.

### Good Default UX

When starting from a template, show:

> Starting from Shopping template. You can edit every rule.

Do not imply that Shopping, Social, Finance, etc. are fixed product modes.

### Example Simple Toggles

Allowed:

- Can browse websites
- Can compare products
- Can add items to cart

Ask me first:

- Before logging in
- Before buying anything
- Before sharing my email
- Before sharing my phone number
- Before submitting forms

Never allow:

- Buying subscriptions
- Saving payment methods
- Uploading government ID
- Sharing sensitive identity documents

### Advanced Rule Example

Human-readable rule:

> If the agent tries to purchase over $50, ask me first.

Underlying logic:

action_type = purchase  
amount_greater_than = 50  
decision = approval_required

### Save Button

Primary CTA:

> Save Collar

Secondary CTA:

> Preview Rules

## Screen 4: Active Session

### Purpose

The Active Session screen shows what an agent is doing right now.

It should be calm and summarized.

It should not be a wall of logs.

### Key Sections

#### Session Header

- agent name
- collar name
- status
- current website
- time remaining

Example:

Shopping Agent  
Collar: Custom Shopping Collar  
Status: Browsing  
Current site: example-store.com  
Expires in: 1h 42m

#### Current Status

Simple statement:

> Your agent is browsing product pages.

Or:

> Your agent is waiting for approval.

Or:

> Aegis blocked a risky action.

#### Allowed / Ask First / Blocked Summary

Show quick policy summary.

Allowed:

- Browse
- Compare
- Add to cart

Ask first:

- Purchase
- Login
- Share contact info

Blocked:

- Subscription
- Government ID upload

#### Recent Activity

Trust-relevant events only:

- Session started
- Navigated to example-store.com
- Added item to cart
- Checkout detected
- Approval requested

#### Controls

Buttons:

- Pause Agent
- Revoke Access
- View Browser
- View Receipts

### Session States

Possible statuses:

- Active
- Browsing
- Waiting for approval
- Paused
- Blocked
- Revoked
- Closed
- Expired

### View Browser

If the session is headless, user can click:

> View Session

This should open a visible preview or screenshot.

The user should not be forced to watch the session constantly.

## Screen 5: Approval Inbox

### Purpose

The Approval Inbox is the most important user trust surface.

It should make sensitive decisions clear, fast, and safe.

### Approval Card Must Show

- what the agent wants to do
- agent name
- collar name
- website/domain
- trust status of website if known
- why approval is required
- what happens if approved
- what data or money is involved
- approve and deny buttons

### Example Approval Card

Your Shopping Agent wants to purchase running shoes for $89.99.

Agent: Shopping Agent  
Website: example-store.com  
Business status: Unverified  
Collar: Custom Shopping Collar  
Reason: Purchases require approval.

If approved, Aegis Runner will complete the purchase without exposing your payment details to the agent.

Buttons:

- Approve Once
- Deny
- View Session
- Pause Agent

### Approval Copy Principles

Be specific.

Bad:

> Approve action?

Good:

> Approve $89.99 purchase from example-store.com?

Bad:

> Share data?

Good:

> Share your verified student status only. Your full student ID will not be shared.

Bad:

> Continue?

Good:

> Let Aegis Runner submit this form using your approved shipping address?

### Approval Outcomes

If approved:

> Approved. Aegis Runner is completing the step.

If denied:

> Denied. The agent cannot complete this action.

If blocked:

> Blocked by collar. This action is not allowed.

### Avoid Approval Fatigue

The Approval Inbox should only appear for meaningful risk.

Do not ask for approval on:

- scrolling
- reading
- searching
- comparing
- opening pages
- drafting text
- low-risk navigation

Ask for approval on:

- purchases
- payments
- login
- posting
- sending
- uploading
- submitting
- identity disclosure
- account changes

## Screen 6: Receipts

### Purpose

Receipts create accountability.

They should show what happened without exposing unnecessary private information.

### Receipt List

Each receipt card should show:

- action type
- agent name
- collar
- domain
- decision
- outcome
- timestamp

Example:

Purchase approved  
Shopping Agent  
example-store.com  
Approved by user  
Completed  
10:42 PM

### Receipt Detail

Receipt detail should show:

- receipt ID
- session ID
- agent name
- collar used
- action type
- decision
- approval status
- counterparty domain
- whether sensitive data was shared with agent
- outcome
- timestamp
- issue report button

Example:

Receipt ID: rec_123  
Agent: Shopping Agent  
Collar: Custom Shopping Collar  
Action: Purchase  
Decision: Approved by user  
Website: example-store.com  
Sensitive data shared with agent: No  
Outcome: Completed  
Time: 10:42 PM

### Receipt Copy

Explain:

> Receipts record trust-relevant events. They are not full browsing logs.

### User Actions

Buttons:

- Report Issue
- View Related Session
- Download Receipt
- Copy Receipt ID

## Mobile Experience

Long-term, the Approval Inbox should probably be mobile-first.

Mobile is ideal for:

- push approvals
- pause/revoke
- quick receipts
- elder/family trusted contact approvals
- sensitive action confirmations

MVP can be web-only, but the approval card should be designed as if it could become a mobile push notification.

Example mobile notification:

> Shopping Agent wants to buy running shoes for $89.99. Approve?

Buttons:

- Approve
- Deny

## Empty States

### Dashboard Empty State

Headline:

> No agents protected yet.

Body:

> Create an Aegis Pass to secure an agent built anywhere.

CTA:

> Secure a New Agent

### Approval Empty State

Headline:

> No approvals waiting.

Body:

> Aegis will notify you when an agent tries to do something sensitive.

### Receipts Empty State

Headline:

> No receipts yet.

Body:

> Receipts appear when Aegis handles sensitive actions.

### Sessions Empty State

Headline:

> No active sessions.

Body:

> Protected sessions start when an agent requests web access through Aegis.

## Tone and Language

Use plain language.

Prefer:

- agent
- collar
- pass
- approval
- receipt
- protected session
- sensitive action

Avoid overusing:

- policy engine
- OAuth
- cryptographic signature
- revocation list
- authorization framework
- security boundary

Technical terms can appear in docs, but the product UI should stay simple.

## Important Product Copy

### Main tagline

> Safely send AI agents into the world.

### Alternate tagline

> Give agents boundaries before they act for you.

### Dashboard copy

> Your agents are protected.

### Agent pass copy

> This pass lets your agent request protected access without receiving your raw secrets.

### Collar copy

> Define what this agent can do, what requires approval, and what is never allowed.

### Approval copy

> Aegis paused this action because it crosses a boundary you set.

### Receipt copy

> Receipts record trust-relevant events, not every click.

## Visual Design Direction

Aegis should feel:

- premium
- calm
- protective
- secure
- modern
- neutral
- trustworthy

Possible visual metaphors:

- shield
- collar
- passport
- control layer
- protected session
- boundary
- gate
- receipt trail

Avoid:

- hacker aesthetic
- aggressive red security dashboard
- noisy cyberpunk UI
- cartoon robot overload
- enterprise clutter

## Information Hierarchy

Every screen should prioritize:

1. What is happening?
2. Is it safe?
3. What does the user need to do?
4. What rule applied?
5. What record was created?

Do not lead with implementation details.

## Trust Cues

Aegis should show trust through:

- clear explanations
- visible rules
- minimal approval spam
- receipts
- no raw secret exposure
- revocation controls
- verified website/business labels when available
- clear distinction between allowed, approval-required, and blocked

## Key User Controls

Users should always be able to:

- pause an active session
- revoke an Aegis Pass
- revoke a collar
- deny an approval
- view receipts
- see what collar is active
- understand why something was blocked or approved

## Revocation UX

Revocation should be easy.

Buttons:

- Pause Agent
- Revoke Access
- Revoke Collar
- Close Session

Copy:

> Revoking access stops this agent from requesting new protected actions through Aegis.

For high-risk cases:

> Emergency Lockdown

This can come later.

## Customization UX

Because collars are fully customizable, the UX must avoid overwhelming users.

Suggested approach:

### Step 1

Start with plain-language defaults.

### Step 2

Let user adjust common toggles.

### Step 3

Offer advanced rules for power users.

### Step 4

Show a summary before saving.

Example summary:

This agent can browse and compare freely.  
It must ask before buying, logging in, or sharing contact info.  
It can never buy subscriptions, save payment methods, or upload government ID.

## MVP UX Non-Goals

Do not build:

- full mobile app
- complex admin dashboard
- enterprise role permissions
- public reputation profiles
- full business verification UX
- full identity verification UX
- full password vault UX
- agent marketplace
- complex analytics dashboard
- notification settings maze

The MVP should be simple and demoable.

## MVP Screen Checklist

Required:

- Dashboard
- Create Aegis Pass
- Collar Editor
- Active Session
- Approval Inbox
- Receipt List
- Receipt Detail

Optional:

- Visible browser preview
- Basic reputation summary
- Mock domain trust badge
- Prompt injection report button

## UX Success Criteria

The user should understand:

- Aegis does not create the agent.
- Aegis secures agents built elsewhere.
- Collars are customizable.
- The agent can browse freely.
- Aegis steps in for sensitive actions.
- Raw secrets stay away from the agent.
- Approvals are only for meaningful risk.
- Receipts create accountability.

## Demo UX Flow

The demo should visibly show:

1. Create custom collar.
2. Create Aegis Pass.
3. Agent starts protected session.
4. Agent browses freely.
5. Checkout detected.
6. Approval request appears.
7. User approves.
8. Runner completes sensitive step.
9. Receipt appears.
10. Dashboard trust signals update.

## Core Lines To Preserve

- Aegis is the collar you put on AI agents before letting them act for you.
- Do not give your agent your password. Give it an Aegis Pass.
- Agents can browse. Aegis decides when they can commit.
- Set the boundaries once. Aegis only interrupts when the agent crosses them.
- Outside agents plan. Aegis executes sensitive steps.
- Receipts record trust-relevant events, not every click.
- Aegis lets people safely send AI agents into the world.


