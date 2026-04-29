# CLAUDE_PROMPT.md

## Purpose

This document contains the prompt to use when starting a Claude Code or Codex implementation session for Aegis.

Use this prompt when you want the coding agent to inspect the repo, understand the product direction, and begin implementing the MVP without drifting into the wrong product.

## Prompt

You are helping me build Aegis.

Aegis is the trust and workflow layer for delegated AI action.

Aegis is not an agent builder.

Users should be able to create or use agents from ChatGPT, Claude, Gemini, OpenClaw-style browsers, custom MCP agents, or future agent platforms, then attach Aegis to those agents.

Aegis gives outside agents identity, scoped permissions, verified workflow routes, runtime guardrails, receipts, and reputation.

Two useful metaphors:
- Aegis is Google Maps for AI agents navigating the web. It does not replace websites. It makes websites navigable for agents through verified routes, scoped permissions, and trust signals.
- Agents are becoming workers. Aegis gives them ID badges, access rules, verified workflows, supervision, and accountability.

The core product idea is:

> Aegis is the collar you put on AI agents before letting them act for you.

## One-Line Thesis

Aegis is the trust and workflow layer for delegated AI action.

## Core Thesis

Agents are disposable. Trust is not.

Agents will change constantly across models, prompts, platforms, and runtimes.

The durable layer should be the user’s AegisID, collars, permissions, verified claims, receipts, and reputation history.

Aegis should become that durable trust layer.

## What Aegis Does

A user gives an outside agent an Aegis Pass.

The pass does not contain raw secrets.

The pass lets the agent request controlled capabilities from Aegis, such as:

- protected browser sessions
- login assistance
- payment approval
- verified identity claims
- email send approval
- social post approval
- file upload approval
- website or business verification

The agent asks.

Aegis decides.

## Core Product Loop

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

Core line:

> Agents can browse. Aegis decides when they can commit.

## What Aegis Should Not Become

Do not turn Aegis into:

- an agent builder
- a generic password manager
- a browser automation toy
- a surveillance dashboard
- a prompt-only safety system
- a public social credit score
- a full identity verification company
- an enterprise admin console in the MVP
- a markdown skill-file marketplace
- a platform for running arbitrary code from strangers inside user accounts

Aegis may eventually connect to passwords, OAuth tokens, payment methods, and verified claims, but the product is not credential storage.

The product is controlled agent authority.

Core line:

> Aegis turns secrets into controlled capabilities.

## Security Principles

Do not rely on prompts as the security boundary.

The outside agent should be treated as untrusted.

The model can think, browse, and plan, but Aegis controls sensitive action.

Sensitive actions include:

- login
- payment
- purchase
- subscription
- public posting
- messaging
- email sending
- file upload
- form submission
- identity disclosure
- account setting changes
- OAuth authorization
- irreversible actions

Aegis should step in at these boundaries.

Aegis should not micromanage every click.

Core line:

> Browse freely. Commit safely.

## Collars

Collars are customizable policy objects.

Presets or templates are allowed, but only as starting points.

Do not hardcode the product around “shopping collar” or any single use case.

The backend should treat collars generically.

A collar should define:

- allowed actions
- approval-required actions
- blocked actions
- spending limits
- identity claim rules
- credential rules
- counterparty rules
- file rules
- messaging rules
- session limits
- receipt settings

Example action types:

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

## The 5 Product Pillars

Build with these five pillars in mind at all times:

1. **AegisID** — Verifiable identity for users, agents, businesses, websites, and APIs
2. **Delegation and Permissions (Collars)** — Scoped, signed, revocable authority objects
3. **Verified Workflow Routes — Aegis Rails** — Structured, declarative, enforceable execution paths for complex workflows
4. **Runtime Guardrails — Aegis Guard** — The detector + policy engine + approval flow layer, taken together
5. **Accountability and Audit Trail** — Receipts recording what was delegated, done, approved, and blocked

## Aegis Rails

Agents without Aegis improvise on websites built for humans. Agents with Aegis can follow verified workflow routes — structured, inspectable, permission-scoped execution paths that trusted creators have already walked once.

A route is **not** a markdown file. A route is **not** arbitrary JavaScript. A route is a declarative object that can be read, reviewed, versioned, permissioned, and enforced.

Route lifecycle:
1. Teach — Human demonstrates the workflow
2. Record — Aegis captures accessibility tree, DOM metadata, browser events (not screenshots as primary)
3. Compile — Aegis produces a declarative route object
4. Verify — Route is reviewed and assigned a trust tier
5. Publish or save privately
6. Discover — Agent queries registry for a matching route
7. Execute with guardrails (Aegis Guard enforces the route)
8. Audit — Receipts record the execution

Route objects include: domain, workflow name, route ID, version, creator AegisID, trust tier, required permissions, allowed actions, forbidden actions, approval gates, pause conditions, success conditions, steps, element targets, fallback selectors, confidence thresholds.

See `docs/AEGIS_RAILS.md` for the full technical spec and TypeScript schema.

Key rules for routes:
- Declarative only — no executable code in routes
- Routes cannot override collar restrictions (collar always wins)
- Confidence-gated execution — pause rather than guess when element matching fails
- Prefer accessibility tree over screenshots for recording

### Rails Architecture — Three Layers

Aegis Rails has three distinct implementation surfaces. Do not mix them.

**Layer 1 — Browser extension (teaching surface):**
Humans demonstrate workflows here. The extension records semantic telemetry: accessibility role, accessible name, label/aria associations, nearby text context, placeholder, stable CSS selectors. Screenshots are never the primary representation. Raw coordinates are the emergency fallback only. A field resolver must run on every interacted element to extract the semantic label chain before storing a locator.

**Layer 2 — Playwright (verification surface):**
Playwright replays compiled routes in a sandbox to test selector confidence, validate navigation events, and run regression checks. It is not the teaching surface. Users do not interact with Playwright to record workflows.

**Layer 3 — Aegis action API (execution surface):**
Agents request individual actions through the Aegis action API. Aegis checks each request against the route definition, the active collar, confidence scores, and approval gates, then responds with `allow`, `block`, `pause`, or `escalate`. The browser only executes the action on `allow`. Agents never receive a Playwright handle or unrestricted browser context.

Route steps use Playwright-style `RouteLocator` objects — not raw CSS strings or XPath — as the primary locator format. Every input step has a `ValuePolicy` that determines whether the value is stored, redacted, or supplied at runtime.

See `docs/RAILS_ARCHITECTURE.md` for the full implementation spec.

## Aegis Guard

Aegis Guard is the umbrella product name for the runtime monitoring and enforcement layer. It includes:

- `SensitiveActionDetector` — rule-based classification of what the agent is trying to do
- `PolicyService` — evaluates the detected action against the active collar (and route, when present)
- Approval inbox — surfaces `approval_required` decisions to the user
- Session pause, block, and revocation

When implementing tasks that touch detection, policy, or approvals, think of these as components of Aegis Guard. Keep them as separate services — do not merge them.

## Route Marketplace / Registry

Aegis can become an agent-readable registry of verified routes. Agents query it at runtime and receive:
- Recommended route
- Trust score and trust tier
- Required permissions
- Approval gates
- Allowed and blocked actions

Trust tiers (ascending): Unverified draft → Community → Aegis scanned → Aegis reviewed → Run verified → Business official.

Marketplace routes must be inspectable before use. Never allow an agent to execute a marketplace route without the user being able to see what the route does, what it never does, and who verified it.

## Terminology

Always use:
- AegisID
- Collar (in code), "scoped permissions" or "delegation" (in product copy)
- Aegis Pass
- Aegis Runner
- Aegis Guard (umbrella for detector + policy + approval)
- Aegis Rails (for the verified workflow routes system)
- Verified workflow route
- Route registry
- Delegated AI action
- Audit trail

Avoid or downplay:
- "Password manager" as the main identity
- "Generic browser agent"
- "Markdown skill file" as a route
- "Arbitrary script execution"
- "Train a model" (we compile routes, not train models)
- "Fully autonomous unrestricted agents"

## Aegis Protected Sessions

For the MVP, use Playwright-controlled Chromium.

Do not build a custom browser UI or browser engine.

A protected session should be:

- isolated from the user’s normal browser
- tied to an Aegis Pass
- tied to a collar
- short-lived
- revocable
- headless by default if possible
- visible on demand for demos/debugging
- monitored for sensitive action boundaries

The outside agent should only control the browser through Aegis-approved tools or APIs.

Do not expose the user’s real browser profile, cookies, or password manager to the outside agent.

## Sensitive Action Detection

Start rule-based.

Do not overbuild AI classification.

Initial detection signals:

- URL patterns
- button text
- input types
- form labels
- nearby text
- file upload fields
- payment fields
- password fields
- checkout pages
- post/send/publish buttons
- OAuth pages

Initial sensitive action types:

- login
- purchase
- payment
- subscription
- post_publicly
- direct_message
- send_email
- upload_file
- submit_form
- identity_disclosure
- government_id_upload
- account_setting_change
- oauth_authorize

When uncertain, prefer approval_required over silently allowing high-risk actions.

Do not ask approval for low-risk browsing.

## Policy Engine

Implement a simple policy engine.

Input:

- collar
- session
- action_type
- domain
- context
- counterparty trust status

Output:

- allow
- allow_and_log
- approval_required
- runner_required
- block
- pause_session
- revoke_session

Rules:

- if session expired, block
- if pass revoked, block
- if collar revoked, block
- if action in blocked_actions, block
- if action in approval_required_actions, approval_required
- if action in allowed_actions, allow
- if action is unknown but sensitive, approval_required
- if action is critical and counterparty is unverified, block or approval_required depending on collar

The policy engine should be boring, explicit, and auditable.

## Approval Inbox

Build a simple approval inbox.

Approval cards should show:

- what the agent wants to do
- agent name
- collar name
- website/domain
- reason approval is required
- risk level
- approve button
- deny button
- view session button if available

Approvals should be meaningful, not constant.

Approval fatigue is a product and security risk.

## Aegis Runner

For MVP, Aegis Runner can be simulated.

The Runner represents Aegis performing sensitive steps without exposing raw secrets to the outside agent.

Runner examples:

- complete mock checkout
- fill mock payment field
- submit approved form
- publish approved text in mock social page
- disclose mock verified student claim

The Runner should be:

- short-lived
- narrowly scoped
- collar-bound
- logged
- terminated after completion

Core line:

> Outside agents plan. Aegis executes sensitive steps.

## Receipts

Receipts are trust-relevant records.

Create receipts for:

- approval requested
- action approved
- action denied
- action blocked
- runner completed
- runner failed
- incident reported

Receipts should avoid storing unnecessary private data.

Do not store:

- raw passwords
- full card numbers
- full identity documents
- full browsing history
- full page contents
- full LLM transcripts
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

> Receipts record trust-relevant events, not everything.

## Reputation

For MVP, reputation should be simple.

Track basic metrics:

- protected sessions created
- sensitive actions requested
- approvals granted
- approvals denied
- risky actions blocked
- receipts created
- issues reported

Do not build public reputation scores.

Do not build a full trust graph.

Long-term, reputation should attach to durable AegisID, not disposable agent instances.

Core line:

> Aegis reputation is a history of how safely your agents act under verified delegation.

## MVP Required Features

Build only the MVP loop.

Required:

- basic dashboard
- create collar
- edit collar
- create Aegis Pass
- outside-agent API to create protected session
- Playwright/Chromium protected session
- simple browser tools: navigate, click, type, read page, screenshot if useful
- sensitive action detector
- policy engine
- approval inbox
- approve/deny flow
- simulated Runner
- receipt log
- basic reputation summary

Optional:

- mock store for reliable demo
- mock verified business
- mock student claim
- visible browser mode
- MCP adapter

Do not build:

- real password storage
- real credit card handling
- real government ID verification
- full OAuth integrations
- business verification
- website trust graph
- family controls
- elder protection
- insurance
- public reputation score
- agent marketplace

## Suggested First Implementation Order

1. Inspect repo structure.
2. Identify existing frontend/backend stack.
3. Propose smallest implementation plan.
4. Add shared types for actions, collars, passes, sessions, approvals, receipts.
5. Implement in-memory or simple database storage.
6. Implement collar creation and policy evaluation.
7. Implement Aegis Pass creation.
8. Implement protected session creation with Playwright.
9. Implement browser actions: navigate, click, type, read page.
10. Implement sensitive action detection.
11. Connect detector to policy engine.
12. Implement approval inbox.
13. Implement approve/deny flow.
14. Implement simulated Runner.
15. Implement receipts.
16. Implement reputation summary.
17. Add mock store if needed for demo stability.
18. Polish demo UI.

## Important Build Constraints

Before editing files:

- inspect the repo
- understand the current stack
- identify the smallest set of files to change
- avoid unnecessary architecture
- avoid premature abstractions
- keep code readable
- prefer simple services over complex frameworks
- do not build future features early

When making changes:

- keep domain logic separate from UI
- keep policy evaluation separate from browser automation
- keep detection separate from policy
- keep receipts separate from reputation aggregation
- use clear TypeScript types
- add comments where security assumptions matter

## Suggested Service Boundaries

Use services like:

- CollarService
- PassService
- BrowserSessionService
- SensitiveActionDetector
- PolicyService
- ApprovalService
- RunnerService
- ReceiptService
- ReputationService

Do not cram all logic into components.

## Suggested UI Screens

Build simple screens:

- Dashboard
- Create Aegis Pass
- Collar Editor
- Active Session
- Approval Inbox
- Receipts

The UI should be simple and demoable.

## Product Copy To Use

Use these lines in the UI where appropriate:

- Safely send AI agents into the world.
- Secure a New Agent.
- Do not give your agent your password. Give it an Aegis Pass.
- Agents can browse. Aegis decides when they can commit.
- This pass lets your agent request protected access without receiving your raw secrets.
- Define what this agent can do, what requires approval, and what is never allowed.
- Aegis paused this action because it crosses a boundary you set.
- Receipts record trust-relevant events, not every click.

## Demo Path To Preserve

The final demo should show:

1. User creates custom collar.
2. User creates Aegis Pass.
3. Outside agent requests protected session.
4. Aegis launches session.
5. Agent browses demo store.
6. Agent adds item to cart.
7. Agent attempts checkout.
8. Aegis detects purchase/payment.
9. Aegis pauses session.
10. Approval request appears.
11. User approves.
12. Runner simulates checkout.
13. Receipt appears.
14. Reputation summary updates.

## Final Reminder

Build Aegis as a trust and control layer for outside agents.

Do not build an agent builder.

Do not build a password manager.

Do not build a surveillance dashboard.

Build the collar, protected session, approval, runner, receipt, and reputation loop.

Core lines:

- Agents are disposable. Trust is not.
- Aegis is the collar you put on AI agents before letting them act for you.
- Agents can browse. Aegis decides when they can commit.
- Outside agents plan. Aegis executes sensitive steps.
- Receipts record trust-relevant events, not everything.


