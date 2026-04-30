# PRODUCT_THESIS.md

## Purpose

This document defines the product thesis for Aegis.

Aegis is the trust and control layer for autonomous AI agents.

It is not an agent builder.

It is the layer users attach to agents built anywhere so those agents can act with identity, boundaries, approvals, receipts, and reputation.

Core line:

> Agents are disposable. Trust is not.

## The Problem

AI agents are becoming capable of acting across the web.

They will browse websites, log into accounts, compare products, book travel, send emails, post online, submit forms, use APIs, access documents, and make decisions on behalf of users.

But today, there is no simple neutral layer that answers:

- Who is this agent acting for?
- Is there a real verified user behind it?
- What is the agent allowed to do?
- What is it blocked from doing?
- What requires approval?
- What credentials can it use?
- What identity claims can it disclose?
- Is the website or business it is interacting with real?
- What happened if something went wrong?

The current options are bad.

Users either give agents too much authority or keep agents too limited to be useful.

Businesses either block agent traffic or treat it like unsafe automation.

Agents either rely on prompts to behave safely or waste time trying to verify trust from scratch.

Aegis exists because autonomous agents need a trust and control layer.

## The Core Insight

Agents are not normal software.

Traditional software is deterministic enough that permissions can often be coded directly.

Agents are different.

They interpret language, browse messy websites, use tools, react to context, and can be prompt-injected.

You cannot rely on telling an agent:

> Do not buy anything.

That is useful guidance, but it is not enforcement.

The model is not the secure boundary.

The secure boundary should be the credentials, tools, browser session, approval flow, identity claims, and action execution layer.

Core line:

> The model can think whatever it wants. Aegis controls what it can do.

## What Aegis Is

Aegis is the trust and control layer for agents built anywhere.

Aegis lets users attach a customizable collar to an outside agent.

The collar defines:

- what the agent can do
- what the agent cannot do
- what requires approval
- what verified claims the agent may use
- what credentials the agent may request
- what websites or businesses it may interact with
- what receipts should be created
- when its authority expires

The agent can browse, research, compare, plan, and draft.

Aegis steps in when the agent tries to commit to something sensitive.

Core line:

> Agents can browse. Aegis decides when they can commit.

## What Aegis Is Not

Aegis is not an agent builder.

Users should be able to use ChatGPT, Claude, Gemini, OpenClaw-style agents, custom MCP agents, or any future agent platform.

Aegis secures those agents instead of replacing them.

Aegis is not just a password manager.

It may store or connect to passwords, tokens, payment methods, and verified claims, but the product is not credential storage.

The product is controlled agent authority.

Aegis is not prompt-only safety.

Prompts can guide agents, but they should not be the security boundary.

Aegis is not a surveillance dashboard.

It should not track every click, scroll, page, token, or private message by default.

Aegis is not a legal liability judge.

It should preserve evidence of delegation, approval, policy, and action, but it should not claim to determine liability.

## The Collar Metaphor

Aegis is the collar you put on an AI agent before letting it act for you.

A collar is not a markdown file.

A collar is not a prompt.

A collar is not a suggestion.

A collar should become a signed, revocable, enforceable permission object.

It travels with the agent session and defines what the agent can request from Aegis.

The agent carries the collar.

Aegis defines what the collar means.

## Why Collars Matter

As agents become easier to create, people will spin up agents constantly.

A user might create:

- a shopping agent
- a travel agent
- a social media agent
- an email agent
- a school agent
- a finance assistant
- a family assistant
- an elder care assistant

These agents may come from different platforms and may be temporary.

The user should not need to trust each new agent from scratch.

Instead, the user should attach a collar.

The collar gives the agent useful but limited authority.

Core line:

> Do not give your agent your password. Give it an Aegis Pass.

## Aegis Pass

An Aegis Pass is what the user gives to an outside agent.

It does not contain raw secrets.

It does not give the agent full account access.

It lets the agent request controlled capabilities from Aegis.

For example, an agent may request:

- protected web access
- login assistance
- payment approval
- verified student claim
- email send approval
- social post approval
- file upload approval
- website or business verification

The agent asks.

Aegis decides.

## Protected Sessions

Aegis Protected Sessions are controlled browser sessions for agents.

The agent can use the web, but Aegis monitors sensitive boundaries.

Aegis should allow normal browsing:

- reading
- scrolling
- searching
- comparing
- drafting
- adding items to cart
- gathering options

Aegis should gate sensitive commitments:

- logging in
- paying
- purchasing
- subscribing
- posting
- messaging
- sending email
- uploading files
- submitting forms
- disclosing identity
- changing account settings
- doing irreversible actions

The browser does not need to feel like a custom browser to the user.

Long-term, agents should be able to request protected sessions automatically when they need the web.

## Aegis Guard

Aegis Guard is the runtime monitoring and enforcement layer.

It is the umbrella product name for three existing components taken together:

- **SensitiveActionDetector** — rule-based classification of what an agent is trying to do
- **PolicyService** — evaluates the detected action against the active collar (and route, when present)
- **Approval inbox** — surfaces `approval_required` decisions to the user

Aegis Guard is why the model is not the security boundary. The model can think whatever it wants. Aegis Guard controls what it can commit to.

Keep these three components as separate services. They compose, but they are not the same concern.

## Aegis Runners

Aegis Runners are temporary executors for sensitive steps.

Outside agents should do the heavy lifting:

- research
- comparison
- reasoning
- planning
- drafting

Aegis Runners should do sensitive execution:

- log in without exposing passwords
- complete approved payments without exposing cards
- disclose verified claims without exposing raw identity
- publish approved posts
- send approved emails
- upload approved files
- submit approved forms

Runners are narrow, short-lived, logged, and terminated after completion.

Core line:

> Outside agents plan. Aegis executes sensitive steps.

## AegisID

AegisID is the durable identity and reputation layer.

AegisID can represent:

- users
- agent sessions
- businesses
- websites
- APIs

For users, AegisID can hold reusable verified claims:

- verified human
- verified student
- verified employee
- verified adult
- verified guardian
- verified business owner

For businesses and websites, AegisID can prove:

- domain ownership
- legal business existence
- agent interaction policy
- dispute history
- prompt-injection reports
- agent-safe status

AegisID is what lets agents and websites verify each other.

Core line:

> Platform IDs prove origin. AegisID proves trust.

## Verified Claims

One of the strongest opportunities for Aegis is reusable verified claims.

Agents should be able to take advantage of the user’s real-world identity attributes without exposing unnecessary information.

Examples:

- use student status for a discount
- use employee status for a benefit
- prove adult status without sharing full birthdate
- prove human verification without exposing government ID
- prove business ownership without exposing private documents
- prove guardian approval for child or elder workflows

This gives agents usable identity.

Core line:

> Aegis gives agents usable identity without exposing unnecessary identity.

## Aegis Rails — Verified Workflow Routes

Agents without Aegis are forced to improvise on websites built for humans.

They try to find the right button, fill the right field, avoid the wrong confirmation dialog — all by guessing. This wastes context, increases failure rates, creates liability ambiguity, and is especially dangerous on sensitive workflows like bank transfers, insurance forms, or medical portals.

When a verified route exists, the agent should not improvise.

Aegis Rails let humans, businesses, and verified creators publish reusable workflow routes that agents can discover and follow. These routes are not markdown prompt files. They are structured, inspectable, permission-scoped, versioned, reviewed, and enforceable execution paths.

### Route Lifecycle

1. **Teach** — A human demonstrates a workflow once
2. **Record** — Aegis captures semantic browser telemetry: accessibility tree, DOM metadata, browser events, network events. Screenshots are an optional fallback, not the primary representation.
3. **Compile** — Aegis produces a declarative route object from the recording
4. **Verify** — The route is reviewed and assigned a trust tier
5. **Publish or save privately** — Route goes to the registry or stays local
6. **Discover** — An agent queries the registry for a matching route
7. **Execute with guardrails** — Aegis Guard enforces the route during execution
8. **Audit** — Receipts record every step, approval, and deviation

### Why Accessibility Tree First

Screenshots are expensive, fragile, and potentially expose sensitive content. The accessibility tree provides the same semantic structure that screen readers use — compact, durable, machine-readable, and safe to store. Aegis should prefer structured telemetry for all route recording and avoid full screenshots as the primary data representation.

### Route Marketplace / Registry

Aegis can become an agent-readable registry of verified routes. When an agent reaches a complex or sensitive task, it can query the Aegis registry with its domain, intent, required permissions, and risk tolerance. Aegis returns a recommended route, trust tier, approval gates, and execution instructions.

Trust tiers (ascending): Unverified draft → Community → Aegis scanned → Aegis reviewed → Run verified → Business official.

Agents should never execute a marketplace route without the user being able to inspect: what the route does, what it never does, what permissions it needs, and who verified it.

Think of the route marketplace as an App Store for agent workflows. Like a mobile app store, any user can build and use their own shortcuts privately — no review required. But publishing to the store for others to discover and install requires passing automated safety checks and a human review. The same model applies here: private skills work immediately for their creator, and marketplace listing is the gate that requires verification and Aegis review.

Routes are private by default. A newly recorded skill is immediately usable by its owner and invisible to all other users and agents. `unverified_draft` is not a broken state — it is the correct state for a personal workflow route. Verification is optional for private use and required before a route can be submitted for marketplace listing.

### Route, Skill, Library, and Runtime — the four-layer model

**Route** is the technical record: ordered steps, locators, value policies, trust tier, verification report. It is what the compiler produces and what Playwright executes. Routes are the implementation layer.

**Skill** is the product package: a route wrapped with a human-readable name, plain-language summary, permission summary, risk level, approval gate declarations, supported domain, and trust evidence. Skills are what users browse, install, and what agents read to decide whether to invoke a workflow.

**Skill Library** is a user's personally installed set of marketplace skills. When a user finds a skill in the marketplace they want their agents to use, they install it. Installed skills are tied to that user and available to their delegated agents. The library is not a mirror of the whole marketplace — it is a deliberate, curated subset.

**Runtime** is domain-scoped and library-scoped. When a third-party agent is operating on `en.wikipedia.org`, it can ask Aegis: "What installed skills do I have for this domain?" Aegis returns only skills from the user's library that match that domain — not a global marketplace search. The agent reads the skill summaries and decides whether to invoke one. Aegis does not push suggestions from the full marketplace at runtime.

Marketplace discovery is intentional — a user or agent explicitly searches for skills and chooses what to install. Runtime surfacing is quiet, scoped, and never global. This distinction is what separates Aegis from a recommendation engine or a skill spam surface.

### What Routes Are Not

A route is not:
- A markdown file describing steps in English
- An arbitrary JavaScript file that runs inside a user's account
- A screenshot sequence
- A prompt template

Routes are declarative. They can be read, reviewed, diffed, versioned, and blocked. No route can contain executable code.

### Routes Do Not Override Collars

A collar's `blocked_actions` always win. If a route step triggers a collar restriction, Aegis falls back to the collar enforcement flow. Routes narrow the execution path within collar-permitted space — they do not expand it.

## Third-Party Agents Are the Primary Integration Surface

Aegis is not an agent builder. It is the trusted operating layer beneath the agents people already use.

Users will keep using ChatGPT, Claude, Gemini, Cursor, OpenClaw-style agents, custom MCP agents, and whatever the next generation of agent runtimes turns out to be. They will not want to replace those agents with something Aegis provides. They will want those agents to act safely on their behalf.

Aegis answers the question those agents cannot answer for themselves:

> "How does this agent prove it is authorized, act within the user's stated limits, handle sensitive execution safely, and leave an audit trail — without the user handing it raw credentials?"

The integration model:

1. User creates a delegation (collar + pass) for the agent they use
2. The third-party agent receives the pass, not the raw password or card
3. The agent browses, plans, and reasons autonomously
4. When the agent reaches a sensitive action boundary, it calls Aegis
5. Aegis enforces the collar, triggers approval if needed, executes sensitive steps via Runner
6. Receipts and reputation events are created
7. The agent continues — Aegis does not control it, it governs the boundary

Route discovery fits inside this model: when an agent reaches a complex site it has never navigated, it can query the Aegis registry for a verified route rather than improvising. Routes save tokens, reduce failure rates, and make the agent more reliable — but they are an efficiency layer on top of the delegation model, not a replacement for it.

The primary customer is a third-party agent that wants to do more for its users than it could with raw browser control and no trust infrastructure. Aegis makes that agent trustworthy enough to act.

## Two-Sided Trust

Aegis should eventually support a two-sided trust handshake.

The agent side proves:

- this agent is backed by a user
- the user is verified if needed
- the agent has an active collar
- the agent is authorized for this task
- sensitive actions require approval

The website or business side proves:

- the domain is verified
- the business is real
- agents are allowed
- the agent policy is published
- the business has acceptable trust history

Aegis decides whether to:

- proceed
- proceed with restrictions
- require approval
- block
- report incident

Core line:

> Verified people. Verified agents. Verified businesses. Verified actions.

## Reputation As The Moat

Reputation is the long-term moat.

But reputation must be built carefully.

Aegis should not track everything.

Aegis should track trust-relevant receipts.

Receipts should record:

- what sensitive action was requested
- what collar applied
- what decision was made
- whether the user approved
- what counterparty was involved
- whether the action completed
- whether there was a dispute or incident

Over time, receipts create trust history.

This trust history can show:

- agents backed by this AegisID complete shopping tasks safely
- this business has low dispute history
- this website has prompt-injection reports
- this user has clean approved purchase history
- this API honors collar restrictions

The moat is not the ID alone.

The moat is the trust graph created by verified delegations, receipts, incidents, approvals, disputes, and outcomes.

Core line:

> Aegis reputation is not a score of who you are. It is a history of how safely your agents act under verified delegation.

## Why This Should Be Neutral

Major platforms will likely create their own agent IDs.

OpenAI, Anthropic, Google, Microsoft, Apple, Cloudflare, Okta, Stripe, and others may each build pieces of agent identity, authorization, or verification.

Aegis should not try to beat them by being another closed platform ID.

Aegis should become the neutral trust layer across them.

A platform ID proves where an agent came from.

Aegis proves whether it is trusted to act under a specific delegation.

Core line:

> Platform IDs prove origin. AegisID proves trust.

## Why Existing Players May Not Fully Solve This

Enterprise identity companies focus on companies.

Web infrastructure companies focus on websites.

Payment companies focus on commerce.

Password managers focus on secrets.

Agent platforms focus on their own agents.

Aegis should focus on the user-centered, cross-platform trust layer for agents acting across the web.

Aegis should integrate with these systems where possible, not blindly compete with them.

Aegis can use identity providers, payment providers, password managers, browser automation, and website verification as inputs.

The product is the layer above them:

- delegation
- collars
- protected sessions
- approvals
- runners
- receipts
- reputation

## Consumer Angle

Normal users will not want to configure Okta-style policy engines.

They will want simple peace of mind.

Aegis should let users say:

- this agent can browse but not buy
- this agent can draft but not post
- this agent can search email but not send
- this agent can use my student claim but not my full identity
- this agent can book travel only with approval
- this agent cannot share sensitive data with unverified websites

Aegis should feel like:

> Set the boundaries once. Aegis only interrupts when the agent crosses them.

## Business Angle

Businesses will need to distinguish legitimate delegated agents from bots, scrapers, fraud, and unsafe automation.

Aegis can help businesses answer:

- is this agent backed by a verified user?
- what is the agent authorized to do?
- did the user approve this action?
- what collar applies?
- can this agent submit forms, purchase, or upload files?
- should this interaction be trusted, restricted, or blocked?

Aegis can also help businesses verify themselves to users and agents.

## Initial Wedge

The first wedge — the protected browser/session and collar system — is proven and working.

The core loop is demonstrated:

- outside agent requests web access
- Aegis launches protected session
- agent browses freely
- Aegis Guard detects sensitive boundary
- collar policy applies
- approval or block happens
- Aegis Runner executes sensitive step
- receipt is created

## Implemented Wedge: Verified Workflow Rails ✓

Verified workflow rails are implemented. The full lifecycle works:

1. User demonstrates a workflow once in the Chrome extension
2. Aegis captures semantic browser telemetry (accessibility tree first, not screenshots)
3. Aegis compiles the recording into a declarative route object
4. Playwright verifies the route; passing verification promotes trust tier to `aegis_scanned`
5. User keeps the route private (usable immediately) or submits it for marketplace review
6. Marketplace routes require Aegis review; approved routes are discoverable by agents
7. Visual replay and parameterized variables are supported

The Google Maps metaphor applies: Aegis does not replace websites. It makes websites navigable for agents through verified routes, scoped permissions, and trust signals. But routes are one pillar — not the whole product.

## Next Wedge: Agent Delegation and RouteRun API

The core product value is the trust operating layer that third-party autonomous agents plug into. The next concrete wedge makes that integration surface real.

Agents built by anyone (ChatGPT plugins, Claude MCP agents, custom runtimes) should be able to:

1. Request a delegation from a user — receiving a pass + collar without the user manually pre-creating them
2. Query available routes for the domain and task at hand
3. Request a RouteRun — agent-initiated workflow execution with Aegis enforcing the route + collar
4. Receive a run receipt when the execution completes or requires approval

This is the wedge that turns Aegis from "a dashboard users configure" into "infrastructure agents depend on." The route marketplace provides the content. The delegation + run API provides the integration point.

First integration test: a simple Node.js script that acts as a fake third-party agent — requests delegation, queries routes, triggers a run — and validates the full trust loop end to end.

## MVP Scope

The first MVP should include:

- Aegis Pass creation
- customizable collar
- protected browser session
- sensitive action detector
- policy engine
- approval inbox
- simulated or simple Aegis Runner
- receipt log
- basic reputation events

The first MVP should not include:

- full password manager
- real credit card handling
- full government ID verification
- universal business verification
- full website trust graph
- insurance
- family controls
- elder protection mode
- public reputation scores
- agent marketplace

Those are future expansions.

## Why This Can Become Big

If agents become a major interface to the internet, then the world will need a trust layer between agents and real-world authority.

Aegis can become the layer that answers:

- who is acting?
- who authorized it?
- what can it do?
- what claims can it use?
- what business is it interacting with?
- was this approved?
- what happened?
- can this interaction be trusted?

That is bigger than a password manager.

It is bigger than a browser wrapper.

It is bigger than an agent dashboard.

It is the trust and control layer for the agentic internet.

## Risks

### Risk 1: Aegis becomes a password manager

If the product focuses only on storing credentials, it becomes a commodity password manager.

Avoid this by focusing on controlled capabilities, collars, runners, and receipts.

### Risk 2: Aegis becomes an agent builder

If the product starts creating agents, it loses neutrality.

Avoid this by supporting outside agents and platform-agnostic integration.

### Risk 3: Aegis becomes too tedious

If users must approve every small action, they will stop using it.

Avoid this by letting agents browse freely and asking only at sensitive action boundaries.

### Risk 4: Aegis tracks too much

If Aegis records everything, it becomes creepy and legally risky.

Avoid this by logging trust-relevant receipts only.

### Risk 5: Aegis cannot enforce outside controlled sessions

If users give agents raw credentials or unrestricted browsers, Aegis cannot reliably protect them.

Avoid this by making Aegis Pass and protected sessions easier than unsafe alternatives.

### Risk 6: Incumbents copy parts of the product

Large platforms may build platform-specific agent IDs, permissions, or approval systems.

Avoid this by becoming the neutral cross-platform layer and building reputation across platforms.

## Strategic Positioning

Consumer positioning:

> Aegis protects you when AI agents act on your behalf.

Developer positioning:

> Aegis gives agents controlled capabilities instead of raw credentials.

Business positioning:

> Aegis helps businesses distinguish verified, user-authorized agents from unsafe automation.

Investor positioning:

> Aegis is the neutral trust and control layer for the agentic internet.

## Core Lines To Preserve

- Agents are disposable. Trust is not.
- Aegis is the collar you put on AI agents before letting them act for you.
- Do not give your agent your password. Give it an Aegis Pass.
- Agents can browse. Aegis decides when they can commit.
- Outside agents plan. Aegis executes sensitive steps.
- Aegis lets agents use your authority without possessing your secrets.
- Aegis gives agents usable identity without exposing unnecessary identity.
- Platform IDs prove origin. AegisID proves trust.
- Verified people. Verified agents. Verified businesses. Verified actions.
- Aegis reputation is a history of how safely your agents act under verified delegation.
- Aegis lets people safely send AI agents into the world.


