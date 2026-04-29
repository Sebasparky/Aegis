# Aegis

Aegis is the trust and workflow layer for delegated AI action.

Aegis lets users attach identity, scoped permissions, verified workflow routes, runtime guardrails, and reputation to agents built anywhere. It is not an agent builder. It is the trust and workflow layer users place around agents before those agents act on their behalf.

Two ways to think about Aegis:

- **Google Maps for AI agents.** Aegis does not replace websites. It makes websites navigable for agents through verified routes, scoped permissions, and trust signals. Without Aegis, agents improvise. With Aegis, agents follow verified paths.
- **ID badges for AI workers.** Agents are becoming workers. Aegis gives them identity, access rules, verified workflows, supervision, and accountability.

> Do not give your agent your password. Give it an Aegis Pass.

## Core Thesis

As AI agents become easier to create, agents themselves will become disposable. Users will switch models, prompts, platforms, and runtimes constantly.

But trust should not be disposable.

Aegis creates a durable trust layer that follows the user across agents and platforms. It lets users safely delegate real-world actions to AI agents without handing those agents raw credentials, payment information, private identity documents, or unrestricted account access.

The core idea:

> Agents are disposable. Trust is not.

## What Aegis Does

Aegis gives outside agents a controlled way to act on behalf of users.

Instead of giving an agent full access to a password, credit card, email account, student identity, or social account, the user gives the agent an Aegis Pass with a collar attached.

The collar defines what the agent can do, what it cannot do, and what requires approval.

Aegis then enforces those restrictions through protected browser sessions, tool gateways, temporary Aegis Runners, approval flows, and signed receipts.

The agent can browse, research, compare, plan, and draft freely. Aegis steps in when the agent tries to commit to something sensitive.

Core line:

> Agents can browse. Aegis decides when they can commit.

## The Collar Metaphor

Aegis is the collar you put on an AI agent before letting it act for you.

A collar answers:

- Who is this agent acting for?
- What is it allowed to do?
- What is it blocked from doing?
- What requires human approval?
- What identity claims can it use?
- What credentials or accounts can it request access to?
- When does its authority expire?
- What receipts should be created?

Example collars:

- Shopping Collar
- Travel Collar
- Email Collar
- Social Collar
- Finance Collar
- Student Collar
- Family Collar
- Elder Protection Collar

Users should not need to configure complex policy engines. They should be able to choose a collar, attach it to an agent, and let Aegis handle the risk boundaries.

## Aegis Pass

An Aegis Pass is what a user gives to an outside agent.

The pass does not contain raw secrets. It does not give the agent passwords, cards, IDs, or unrestricted account access.

Instead, it lets the agent request controlled capabilities from Aegis.

Examples:

- request a protected browser session
- request login to a website
- request use of a verified student claim
- request approval to send an email
- request approval to publish a post
- request approval to complete a purchase
- request verification of a website or business

The agent asks. Aegis decides.

## Aegis Protected Sessions

Aegis Protected Sessions are controlled browser sessions that agents can use when they need the web.

The agent can browse, scroll, search, read, compare, and plan. Aegis monitors for sensitive action boundaries such as:

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
- irreversible actions

When a sensitive boundary appears, Aegis checks the collar and decides whether to allow, block, ask the user, or hand the step to an Aegis Runner.

Aegis should not micromanage every click. It should govern moments where browsing becomes authority.

## Aegis Runners

Aegis Runners are temporary executors that complete sensitive steps without exposing secrets to the outside agent.

For example:

- logging into Gmail without revealing the password
- completing an approved purchase without exposing the credit card
- publishing an approved LinkedIn post
- sending an approved email
- disclosing a verified student claim without exposing full identity
- uploading an approved file to a verified website

Outside agents handle the heavy lifting: research, planning, browsing, and drafting.

Aegis Runners handle sensitive execution.

Core line:

> Outside agents plan. Aegis executes sensitive steps.

## AegisID

AegisID is the durable identity and reputation layer behind agents, users, businesses, websites, and APIs.

AegisID can represent:

- verified users
- agent sessions
- businesses
- websites
- APIs

For users, AegisID can hold reusable verified claims such as:

- verified human
- verified student
- verified employee
- verified adult
- verified guardian
- verified business owner

These claims should be disclosed minimally. An agent should be able to prove that a user is a student without exposing the user’s full ID, school records, or unnecessary personal information.

Core line:

> Aegis gives agents usable identity without exposing unnecessary identity.

## Aegis Rails — Verified Workflow Routes

Agents without Aegis are forced to improvise on websites built for humans. Agents with Aegis can follow verified workflow routes — structured, inspectable, permission-scoped execution paths that trusted creators have already walked once.

Aegis Rails are not markdown files. They are not arbitrary executable scripts. They are declarative route objects that can be read, reviewed, versioned, permissioned, and enforced.

The route lifecycle:

1. **Teach** — A human demonstrates a workflow once
2. **Record** — Aegis captures semantic browser telemetry (accessibility tree, DOM metadata, browser events)
3. **Compile** — Aegis produces a declarative route from the recording
4. **Verify** — The route is reviewed and assigned a trust tier
5. **Publish or save** — Route goes to the registry or stays private
6. **Discover** — An agent queries the registry for a route matching its task
7. **Execute with guardrails** — Aegis Guard enforces the route during execution
8. **Audit** — Receipts record every step, approval, and deviation

### Route Marketplace / Registry

Aegis can become an agent-readable registry of verified routes. Agents can query it at runtime when they reach complex or sensitive tasks. The registry returns a recommended route, its trust tier, required permissions, approval gates, and execution instructions.

Trust tiers: Unverified draft → Community → Aegis scanned → Aegis reviewed → Run verified → Business official.

See `docs/AEGIS_RAILS.md` for the full technical specification.

## Business and Website Verification

Aegis should eventually support verified businesses and websites.

A business AegisID can prove:

- the business is real
- the domain is owned by that business
- the business supports agent interactions
- the business publishes an agent policy
- the business has a history of safe or unsafe agent interactions

This enables a two-sided trust handshake.

Agents prove who they represent and what they are allowed to do.

Businesses prove they are real, verified, and safe for agents to interact with.

Aegis then decides whether to proceed, restrict, ask for approval, or block.

## Reputation

Reputation is the long-term moat of Aegis.

However, Aegis should not become a surveillance product or a universal social credit score.

Aegis reputation should be:

- category-specific
- privacy-preserving
- explainable
- based on trust-relevant receipts
- tied to verified delegation
- decayed over time

Aegis should not track every click, page, token, or private message by default.

Aegis should track trust-relevant moments such as:

- collar creation
- protected session start
- sensitive capability request
- approval or denial
- sensitive action completion
- verified business interaction
- prompt injection report
- collar violation attempt
- user dispute
- business dispute

Core line:

> Aegis reputation is not a score of who you are. It is a history of how safely your agents act under verified delegation.

## What Aegis Is Not

Aegis is not an agent builder.

Users should be able to use agents from any platform and attach Aegis to them.

Aegis is not just a password manager.

It may store or connect to credentials, but the product is not credential storage. The product is controlled agent authority.

Aegis is not a prompt-only safety system.

Prompts can guide behavior, but they are not the security boundary. Aegis should enforce restrictions through tools, tokens, browsers, approval flows, and temporary executors.

Aegis is not a guarantee that agents will never fail.

Aegis creates safer boundaries, better approvals, clearer accountability, and a reputation trail.

## MVP Direction

### Current MVP (Working)

The first MVP proves the core trust and control loop:

1. User creates an Aegis Pass and Shopping Collar.
2. Outside agent requests an Aegis Protected Session.
3. Agent browses freely inside the protected session.
4. Aegis Guard detects a sensitive action boundary (checkout, payment).
5. Aegis checks the collar.
6. Aegis asks for approval or blocks the action.
7. Aegis Runner completes approved sensitive execution.
8. Aegis creates a receipt and updates reputation signals.

Working demo: `http://localhost:3000/demo`

### Next Milestone: Aegis Rails Recording

The near-term wedge after the current MVP is verified workflow rails for browser agents:

1. User clicks "teach a workflow" and demonstrates it once.
2. Aegis records semantic browser telemetry (accessibility tree, DOM events — not full screenshots).
3. Aegis compiles a declarative route object with allowed/forbidden actions and approval gates.
4. The route is saved privately and optionally published to the registry.
5. A future agent queries the registry when it reaches a complex or sensitive task.
6. Aegis returns the best verified route and enforces it during execution.

Do not start with:

- Full password manager
- Full identity verification
- Universal website verification
- Real payment processing
- Insurance
- Family and elder modes
- Full reputation graph

Those are future expansions.

## Product Positioning

Consumer version:

> Aegis protects you when AI agents act on your behalf.

Developer version:

> Aegis gives agents controlled capabilities instead of raw credentials.

Business version:

> Aegis helps businesses distinguish verified, user-authorized agents from unsafe automation.

Investor version:

> Aegis is the neutral trust and control layer for the agentic internet.

## Core Lines

- Agents are disposable. Trust is not.
- Aegis is the collar you put on AI agents before letting them act for you.
- Do not give your agent your password. Give it an Aegis Pass.
- Agents can browse. Aegis decides when they can commit.
- Outside agents plan. Aegis executes sensitive steps.
- Aegis lets agents use your authority without possessing your secrets.
- Aegis gives agents usable identity without exposing unnecessary identity.
- Aegis reputation is a history of how safely your agents act under verified delegation.

