# ROADMAP.md

## Purpose

This document defines the Aegis roadmap.

The goal is to separate the immediate MVP from the larger platform vision.

Aegis should not try to build the whole agentic trust network at once.

The roadmap should move in stages:

1. Prove protected browser enforcement.
2. Prove customizable collars.
3. Prove approval and receipt loop.
4. Add real integrations.
5. Add verified claims.
6. Add business and website verification.
7. Build reputation graph.
8. Expand into family, elder, enterprise, and developer ecosystems.

Core line:

> Start with control. Grow into trust.

## Roadmap Principles

### 1. Build the narrow wedge first

Do not start with the full AegisID network.

Start with one use case where the value is obvious:

> An outside agent can browse freely, but Aegis stops it before purchase, payment, login, posting, uploading, or identity disclosure.

### 2. Avoid becoming an agent builder

Aegis should secure agents built anywhere.

Do not build the agent creation layer unless absolutely necessary for demo purposes.

### 3. Avoid becoming only a password manager

Aegis may use vault-like infrastructure, but the product is controlled agent authority.

### 4. Avoid overcollection

Reputation should come from trust-relevant receipts, not surveillance.

### 5. Keep collars customizable

Templates are useful, but the collar system should be fully customizable from the beginning.

## Phase 0: Founder/Product Docs

Status: current phase

Goal:

Define the product clearly before building.

Docs:

- README.md
- AGENT.md
- PRODUCT_THESIS.md
- MVP_SCOPE.md
- ARCHITECTURE.md
- COLLARS.md
- AEGISID.md
- REPUTATION.md
- DEMO_SCRIPT.md
- IMPLEMENTATION_PLAN.md
- SECURITY_MODEL.md
- API_SPEC.md
- DATA_MODEL.md
- UX_SPEC.md
- BROWSER_ENFORCEMENT.md
- CLAUDE_PROMPT.md
- PITCH.md
- ROADMAP.md

Success criteria:

- product direction is clear
- MVP scope is clear
- non-goals are clear
- implementation path is clear

## Phase 1: MVP Prototype

Goal:

Prove the core loop.

Core loop:

1. User creates custom collar.
2. User creates Aegis Pass.
3. Outside agent requests protected browser session.
4. Aegis launches isolated Playwright/Chromium session.
5. Agent browses freely.
6. Aegis detects sensitive action.
7. Aegis checks collar.
8. Aegis allows, blocks, or requests approval.
9. User approves or denies.
10. Aegis Runner simulates sensitive execution.
11. Receipt is created.
12. Basic reputation event updates.

### Phase 1 Features

Required:

- dashboard
- custom collar editor
- Aegis Pass creation
- protected browser session
- basic browser actions
- rule-based sensitive detector
- policy engine
- approval inbox
- simulated Runner
- receipt log
- basic reputation summary

Optional:

- mock store
- visible browser preview
- headless mode toggle
- mock domain trust
- prompt injection report button
- MCP adapter

### Phase 1 Non-Goals

Do not build:

- real password vault
- real credit card handling
- real government ID verification
- full business verification
- full website trust graph
- family controls
- elder protection mode
- enterprise admin console
- public reputation scores
- agent marketplace

### Phase 1 Success Criteria

The MVP succeeds if someone can watch a demo and understand:

- Aegis is not creating the agent.
- Aegis secures an outside agent.
- Collars are customizable.
- Agent can browse freely.
- Aegis stops sensitive actions.
- User can approve or deny.
- Aegis Runner performs approved sensitive step.
- Receipt creates accountability.

## Phase 2: Real Tool Integrations

Goal:

Move beyond mock browser actions into real useful integrations.

Potential integrations:

- Gmail
- Google Calendar
- GitHub
- Notion
- Slack
- Google Drive
- LinkedIn-style mock integration
- shopping mock or partner store

Prioritize integrations where permissions are clear.

### Phase 2 Features

- OAuth integration for one or two services
- read/draft/send permission split
- collar-controlled tool access
- approval before send/post/submit
- receipts for real actions
- better session activity view

Example Email Collar:

Allowed:

- read selected emails
- search email
- draft reply

Approval required:

- send email
- forward email
- attach file
- email new recipient

Blocked:

- delete email
- change filters
- change account settings

### Phase 2 Success Criteria

Aegis can enforce collars on at least one real integration without relying only on browser detection.

Core line:

> Aegis controls the tools the agent can use.

## Phase 3: Aegis Vault and Capability Broker

Goal:

Turn sensitive authority into controlled capabilities.

Aegis should begin supporting vault-like capabilities without becoming just a password manager.

### Phase 3 Features

- mock or real credential vault
- OAuth token broker
- limited capability tokens
- claim disclosure controls
- secure Runner execution
- approval-bound credential usage
- session expiration and revocation
- audit-safe receipts

Capabilities:

- login_once
- draft_email
- request_send_email
- request_purchase
- prove_verified_student
- use_shipping_address_once
- upload_approved_file
- publish_approved_post

### Phase 3 Success Criteria

Agents can request outcomes without receiving raw secrets.

Core line:

> Aegis lets agents use your authority without possessing your secrets.

## Phase 4: Verified Claims

Goal:

Let agents use reusable identity claims safely.

Aegis should support claims such as:

- verified human
- verified student
- verified employee
- verified adult
- verified guardian
- verified business owner

### Phase 4 Features

- claim vault
- mock claim creation
- claim disclosure rules
- approval for claim usage
- claim receipts
- selective disclosure UI
- claim expiration
- claim revocation

Example:

Agent requests:

> Use verified student claim.

Aegis checks:

- does user have claim?
- does collar allow claim?
- is website trusted?
- does claim require approval?
- what disclosure level is allowed?

### Phase 4 Success Criteria

Aegis can prove a claim without exposing unnecessary identity.

Core line:

> Aegis gives agents usable identity without exposing unnecessary identity.

## Phase 5: Business and Website AegisID

Goal:

Add the counterparty side of the trust network.

Users and agents should be able to know whether a website or business is verified.

### Phase 5 Features

- Business AegisID
- Website AegisID
- domain verification
- mock business verification
- agent policy file discovery
- trust labels
- incident reports
- domain trust checks before sensitive action

Website policy path:

/.well-known/aegis-agent-policy.json

Possible labels:

- unverified
- domain verified
- business verified
- agent policy published
- agent-safe
- restricted
- flagged

### Phase 5 Success Criteria

Aegis can restrict sensitive actions based on website or business trust.

Example:

- browsing unverified site allowed
- payment on unverified site blocked or approval required
- identity disclosure to unverified site blocked
- verified businesses can receive more trusted agent actions

Core line:

> Verified people. Verified agents. Verified businesses. Verified actions.

## Phase 6: Reputation Graph

Goal:

Turn receipts into the moat.

Reputation should remain privacy-preserving and category-specific.

### Phase 6 Features

- receipt aggregation
- category-specific trust summaries
- user AegisID reputation
- business AegisID reputation
- website AegisID reputation
- prompt injection report tracking
- dispute tracking
- trust decay
- explainable trust labels

Do not build a universal social credit score.

Prefer trust claims:

- clean shopping history
- no payment disputes
- verified business
- no recent prompt-injection reports
- identity disclosure history clean

### Phase 6 Success Criteria

Aegis can use past receipts to make better trust decisions.

Core line:

> The ID is not the moat. The trust graph is the moat.

## Phase 7: Mobile Approval App

Goal:

Make approvals fast and natural.

The approval inbox should become mobile-first.

### Phase 7 Features

- push notifications
- approve/deny actions
- view session screenshot
- pause agent
- revoke pass
- view receipt
- trusted contact approval
- emergency lockdown

Mobile approval examples:

- Approve purchase
- Deny public post
- Approve verified student claim
- Block identity upload
- Pause suspicious session

### Phase 7 Success Criteria

Users can approve or deny sensitive actions quickly without living inside the dashboard.

Core line:

> Set the boundaries once. Aegis only interrupts when the agent crosses them.

## Phase 8: Family and Guardian Controls

Goal:

Protect minors and families using agents.

### Phase 8 Features

- child collars
- guardian approval
- blocked site categories
- purchase restrictions
- messaging restrictions
- school-safe mode
- family activity summaries
- trusted contact escalation

Use cases:

- child wants homework assistant
- teen uses social media agent
- family shopping agent
- school portal agent

### Phase 8 Success Criteria

Aegis can protect younger users through guardian-controlled collars.

Core line:

> Parental controls for AI agents.

## Phase 9: Elder Protection Mode

Goal:

Protect older adults and vulnerable users when agents act in sensitive contexts.

### Phase 9 Features

- trusted contact approvals
- scam website warnings
- gift card purchase blocks
- wire transfer blocks
- medical data protections
- payment limits
- suspicious urgency warnings
- caregiver summary
- verified provider checks

Use cases:

- healthcare appointments
- bill payment
- insurance forms
- government forms
- shopping
- messages

### Phase 9 Success Criteria

Aegis can reduce scam and overreach risk in elder agent workflows.

Core line:

> Aegis protects vulnerable users when agents act in sensitive parts of life.

## Phase 10: Developer Platform

Goal:

Let developers integrate Aegis into agents, tools, and websites.

### Phase 10 Features

- Aegis SDK
- MCP server
- API gateway
- verifyAction endpoint
- verifyAgent endpoint
- verifyBusiness endpoint
- requestApproval endpoint
- createReceipt endpoint
- reportIncident endpoint
- policy file tooling
- docs and examples

Developer value:

- easier agent safety
- permission enforcement
- user approval flows
- receipts
- trust signals
- business verification

### Phase 10 Success Criteria

Developers can add Aegis to their agents or tools without building the whole trust stack themselves.

## Phase 11: Business Trust Network

Goal:

Businesses adopt Aegis to receive verified delegated agents.

### Phase 11 Features

- business dashboard
- domain verification
- agent policy configuration
- accepted action rules
- verified agent traffic
- dispute handling
- trust badge
- receipt exports
- incident reporting

Business pitch:

> AI agents are starting to interact with your site. Aegis helps you distinguish user-authorized agents from unsafe automation.

### Phase 11 Success Criteria

Businesses verify themselves because Aegis users and agents bring higher-trust traffic.

## Phase 12: Agent Platform Integrations

Goal:

Make Aegis available inside major agent platforms.

Potential integrations:

- ChatGPT-style agents
- Claude-style agents
- Gemini-style agents
- OpenClaw-style browser agents
- MCP clients
- local agent runtimes
- AI browsers

Aegis should become an optional web access and capability provider.

User chooses:

> Use Aegis Protected Access

instead of giving raw credentials or unrestricted browser access.

### Phase 12 Success Criteria

Agents built outside Aegis can request Aegis-protected sessions and capabilities with minimal setup.

Core line:

> Aegis does not need to create the agent. Aegis needs to be the trust layer the agent carries.

## Phase 13: Agent Marketplace Trust

Goal:

Aegis can help users choose agents safely.

Possible features:

- verified agent developers
- permission transparency
- collar compatibility
- reputation claims
- incident history
- trusted agent badges
- user reviews
- Aegis-compatible labels

This should come much later.

Do not build this early.

## Phase 14: Insurance and Guarantees

Goal:

Explore financial protection around Aegis-verified interactions.

Possible features:

- unauthorized agent action protection
- scam protection
- verified merchant guarantee
- dispute assistance
- partner insurance

This is high-risk and regulated.

Do not build early.

## Long-Term Vision

The long-term vision is a neutral trust network for the agentic internet.

Aegis becomes the place that answers:

- who is this agent acting for?
- what is it allowed to do?
- what identity claims can it use?
- is this website verified?
- is this business trusted?
- was this action approved?
- what receipt exists?
- what reputation history matters?
- should this interaction proceed?

The internet will need a trust layer for autonomous agents.

Aegis should become that layer.

## Build Priority Summary

### Build now

- customizable collars
- Aegis Pass
- protected browser sessions
- sensitive action detection
- approval inbox
- simulated Runner
- receipts
- basic reputation events

### Build next

- real tool integration
- OAuth/token controls
- mock verified claims
- mobile approval
- better browser enforcement
- mock business verification

### Build later

- real identity verification
- business AegisID
- website trust network
- reputation graph
- family controls
- elder protection
- developer platform
- agent platform integrations

### Build much later

- public trust network
- marketplace trust
- insurance
- legal/dispute infrastructure

## Core Lines To Preserve

- Agents are disposable. Trust is not.
- Start with control. Grow into trust.
- Aegis is the collar you put on AI agents before letting them act for you.
- Do not give your agent your password. Give it an Aegis Pass.
- Agents can browse. Aegis decides when they can commit.
- Outside agents plan. Aegis executes sensitive steps.
- Aegis turns secrets into controlled capabilities.
- Aegis gives agents usable identity without exposing unnecessary identity.
- Platform IDs prove origin. AegisID proves trust.
- The ID is not the moat. The trust graph is the moat.
- Aegis lets people safely send AI agents into the world.


