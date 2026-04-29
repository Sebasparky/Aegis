# PITCH.md

## Purpose

This document defines the external pitch for Aegis.

Use this for hackathons, accelerator applications, founder conversations, investor conversations, and product storytelling.

Aegis is the trust and control layer for autonomous AI agents.

Core line:

> Aegis lets people safely send AI agents into the world.

## One-Line Pitch

Aegis is the collar you put on AI agents before letting them act for you.

## Short Pitch

AI agents are starting to browse, shop, email, post, book, and submit forms on behalf of users.

But today, making agents useful often means giving them too much authority: passwords, browser access, payment information, identity documents, or account permissions.

Aegis gives users a safer way.

Instead of giving an agent raw secrets, users give it an Aegis Pass with a customizable collar.

The agent can browse, research, compare, and draft freely. But when it tries to log in, pay, post, upload, submit, or share sensitive information, Aegis steps in.

Aegis checks the collar, asks for approval if needed, uses temporary Runners to complete sensitive steps without exposing secrets, and creates receipts that build reputation over time.

Agents are disposable. Trust is not.

## Medium Pitch

As AI agents become more capable, they will increasingly act across the web on behalf of users.

They will book travel, buy products, send emails, post on social media, access documents, use school portals, interact with banks, fill forms, and communicate with businesses.

But there is no neutral trust layer that answers basic questions:

- Who is this agent acting for?
- What did the user authorize?
- What is the agent allowed to do?
- What requires approval?
- Can this website or business be trusted?
- Was this action approved?
- What happened if something went wrong?

Aegis solves this by giving every outside agent an Aegis Pass and a customizable collar.

The collar defines what the agent can do, what it cannot do, and what requires approval.

Aegis lets agents browse freely, but gates sensitive actions like login, payment, posting, messaging, uploading, submitting, and identity disclosure.

Aegis also creates receipts for trust-relevant events. Over time, those receipts build reputation around how safely agents act under verified delegation.

Aegis is not an agent builder.

Aegis is the neutral trust and control layer around agents built anywhere.

## Long Pitch

The internet is about to get a new kind of user: autonomous AI agents.

These agents will not just answer questions. They will act. They will browse websites, use tools, log into accounts, send messages, make purchases, book reservations, submit forms, and interact with businesses.

That creates a new trust problem.

Users do not want to give agents unrestricted access to passwords, credit cards, identity documents, accounts, and browser sessions.

Businesses do not want to treat every agent like a malicious bot, but they also cannot blindly trust anonymous automation.

Agents themselves need a fast way to know which websites, businesses, APIs, and tools are safe to interact with.

Aegis is the trust and control layer for this agentic web.

Aegis lets users attach a customizable collar to any outside agent.

The collar defines:

- what the agent can do
- what the agent cannot do
- what requires approval
- what identity claims it can use
- what credentials it can request
- what websites or businesses it can interact with
- when its authority expires

The agent can browse, research, compare, plan, and draft freely.

But when it tries to commit to something sensitive, Aegis steps in.

Aegis checks the collar, verifies the counterparty when possible, asks the user for approval when needed, and uses a temporary Aegis Runner to complete approved sensitive steps without exposing raw secrets to the agent.

Then Aegis creates a receipt.

Over time, these receipts build a reputation layer around verified delegation.

The long-term vision is a neutral trust network for the agentic internet:

- verified users
- verified agents
- verified businesses
- verified websites
- verified APIs
- reusable identity claims
- customizable collars
- approval records
- prompt-injection reports
- dispute history
- reputation signals

Aegis does not need to create the agents.

Aegis becomes the layer that lets people and businesses trust agents built anywhere.

Core line:

> Platform IDs prove origin. AegisID proves trust.

## Problem

AI agents need authority to be useful.

But authority creates risk.

Today, users often have to choose between:

1. Agents that are safe but useless.
2. Agents that are useful but over-permissioned.

If a user wants an agent to shop, email, post, book, or fill forms, they may need to give it:

- browser access
- account access
- passwords
- payment information
- identity documents
- files
- personal data

That is dangerous.

Agents can:

- misunderstand instructions
- hallucinate
- get prompt-injected
- click the wrong thing
- buy the wrong item
- share sensitive information
- post something publicly
- upload the wrong file
- submit a form too early
- interact with scam websites

Prompts alone are not enough.

Telling an agent “do not buy anything” is useful, but it is not enforcement.

Aegis exists because agents need boundaries outside the model.

## Solution

Aegis gives outside agents controlled authority.

Instead of giving an agent raw secrets, the user gives it an Aegis Pass.

The Aegis Pass has a customizable collar attached.

The collar defines:

- allowed actions
- blocked actions
- approval-required actions
- spending limits
- identity claim permissions
- website trust requirements
- file and messaging rules
- expiration

When the agent needs the web, it requests an Aegis Protected Session.

The agent can browse freely.

Aegis only steps in when the agent reaches sensitive action boundaries.

If the action is allowed, it proceeds.

If the action requires approval, Aegis asks the user.

If the action is blocked, Aegis stops it.

If the action requires credentials or sensitive authority, an Aegis Runner performs the approved step without exposing secrets to the outside agent.

## Product Demo

Demo scenario:

A user wants an AI agent to find running shoes under $100.

1. User creates an Aegis Pass.
2. User attaches a custom collar.
3. The collar allows browsing, searching, comparing, and adding to cart.
4. The collar requires approval for login, payment, purchase, email sharing, and shipping address.
5. The outside agent requests a protected browser session.
6. The agent browses a store normally.
7. The agent finds shoes and adds them to cart.
8. The agent reaches checkout.
9. Aegis detects a purchase/payment boundary.
10. Aegis pauses the session.
11. The user gets an approval request.
12. If approved, an Aegis Runner completes the payment without exposing the card to the agent.
13. A receipt is created.
14. Reputation signals update.

This shows the core value:

> Agents can browse. Aegis decides when they can commit.

## Why Now

Agents are moving from chat to action.

The current internet was built around human users and human-controlled sessions.

The next internet will include agents acting on behalf of users.

That creates new needs:

- agent identity
- delegated authority
- scoped permissions
- user approvals
- website verification
- business verification
- prompt-injection reporting
- receipts
- reputation
- accountability

Existing systems solve pieces of this, but not the full user-centered agent trust layer.

Enterprise identity tools focus on companies.

Web security companies focus on websites.

Payment companies focus on payments.

Password managers focus on secrets.

Agent platforms focus on their own agents.

Aegis focuses on the neutral control layer across agents, users, websites, businesses, and APIs.

## Market

Aegis can start with users who are already experimenting with autonomous agents.

Early users may include:

- AI power users
- builders
- founders
- students
- creators
- professionals
- people using AI browser agents
- people delegating shopping, email, posting, or research tasks
- families and caregivers later
- businesses receiving agent traffic later

Long-term markets:

- consumer agent protection
- agent identity and permissions
- protected browser sessions
- agent-safe payments
- verified claims
- business verification
- website trust
- family controls
- elder protection
- enterprise agent governance
- agent reputation network

## First Wedge

The first wedge should be protected browser sessions with customizable collars.

Why?

Because browser agents are intuitive and the risk boundaries are visible.

Users understand:

- browsing is fine
- buying requires approval
- posting requires approval
- logging in requires control
- uploading ID is risky
- sharing payment info is sensitive

The first MVP should not try to verify the whole internet.

It should prove:

> Any outside agent can request protected web access, but Aegis controls sensitive commitments.

## Product Components

### Aegis Pass

The access object a user gives to an outside agent.

It does not contain raw secrets.

It lets the agent request Aegis-controlled capabilities.

### Collars

Customizable permission and restriction policies.

Templates can exist, but users should have full control.

### Protected Sessions

Controlled browser sessions that let agents use the web while Aegis detects sensitive actions.

### Aegis Runners

Temporary executors that complete sensitive steps without exposing secrets to outside agents.

### Approval Inbox

The user-facing place for approving or denying sensitive actions.

### Receipts

Trust-relevant records of sensitive decisions and outcomes.

### Reputation

The long-term trust history built from receipts.

### AegisID

The durable identity and reputation layer behind users, agent sessions, businesses, websites, and APIs.

## Moat

The collar and protected session are the wedge.

The reputation graph is the moat.

Aegis becomes more valuable as it sees more verified delegated interactions.

Over time, Aegis can build trust history across:

- users
- agent sessions
- collars
- businesses
- websites
- APIs
- approvals
- receipts
- disputes
- prompt-injection reports
- successful actions
- blocked risky actions

This creates a network effect.

More users use Aegis.  
More agents carry Aegis Passes.  
More websites and businesses accept Aegis-backed agents.  
More receipts create trust history.  
Aegis reputation becomes more useful.  
More users and businesses adopt Aegis.

Core line:

> The ID is not the moat. The trust graph is the moat.

## Competitive Landscape

Aegis is not trying to directly replace every adjacent player.

Instead, it can integrate with many of them.

### Password managers

They store secrets.

Aegis controls how agents may use authority derived from secrets.

### Identity providers

They verify people or employees.

Aegis turns verified identity into scoped agent delegation.

### Payment providers

They authorize payments.

Aegis decides whether an agent is allowed to request or initiate the payment.

### Cloud and web security platforms

They protect websites from bots and attacks.

Aegis helps distinguish verified, user-authorized agents from unsafe automation.

### Agent platforms

They create agents.

Aegis secures agents across platforms.

Core line:

> Aegis does not need to create the agent. Aegis needs to be the trust layer the agent carries.

## Differentiation

Aegis is different because it combines:

- user-centered agent control
- customizable collars
- protected browser sessions
- sensitive action gating
- temporary Runners
- reusable identity claims
- receipts
- reputation
- future business and website verification

Most competitors attack one layer.

Aegis connects the layers.

## Business Model Possibilities

Early business models:

- freemium consumer app
- paid power-user plan
- subscription for protected agent sessions
- usage-based protected browser sessions
- premium identity claims
- family/elder protection plan
- developer API pricing
- business verification fees
- agent-safe trust badge
- enterprise controls later

Potential pricing examples:

- Free: limited collars and sessions
- Pro: more sessions, advanced collars, identity claims, receipts
- Family: guardian approvals and family controls
- Business: business verification and agent policy support
- Developer: API and MCP integration usage

Do not overbuild pricing early.

## Risks

### Risk 1: Too early

Consumer agents may not be common enough yet.

Mitigation:

Start with AI power users and builders using browser agents now.

### Risk 2: Too broad

The full vision is huge.

Mitigation:

Start with protected browser sessions and customizable collars.

### Risk 3: Too tedious

If Aegis asks for approval constantly, users will churn.

Mitigation:

Only interrupt at sensitive action boundaries.

### Risk 4: Too creepy

If Aegis tracks everything, users will not trust it.

Mitigation:

Store trust-relevant receipts, not surveillance.

### Risk 5: Incumbents copy pieces

Large companies may build agent IDs, approvals, or web protections.

Mitigation:

Be neutral and cross-platform. Build trust history across providers.

### Risk 6: Enforcement limits

Aegis cannot protect agents using raw credentials outside Aegis.

Mitigation:

Make Aegis Pass and Protected Sessions easier than unsafe alternatives.

## Hackathon Pitch

AI agents are starting to act across the web, but making them useful often means giving them too much authority.

Aegis is the collar you put on an AI agent before letting it act for you.

Instead of giving an agent your password, credit card, or ID, you give it an Aegis Pass with a customizable collar.

The agent can browse and plan freely. But when it tries to log in, pay, post, upload, submit, or share sensitive information, Aegis steps in.

Aegis checks the collar, asks for approval if needed, uses a temporary Runner to complete approved sensitive steps, and creates a receipt.

Agents are disposable. Trust is not.

## Accelerator Pitch

Aegis is building the neutral trust and control layer for autonomous AI agents.

As agents move from chat to action, users need a way to safely delegate authority without handing agents raw credentials or unrestricted browser access.

Aegis gives outside agents an Aegis Pass and customizable collar. Agents can browse freely, but Aegis gates sensitive actions like login, payment, posting, uploading, and identity disclosure.

Every sensitive action creates a receipt, and over time those receipts form a reputation graph around verified delegation.

We are starting with protected browser sessions for consumer agents, then expanding into identity claims, business verification, website trust, and agent reputation.

## Investor Pitch

The internet is about to get a new class of actor: autonomous AI agents.

These agents will browse, buy, book, post, message, and submit forms on behalf of users. But the internet lacks a neutral trust layer for agent-mediated action.

Aegis is building that layer.

Users attach customizable collars to agents built anywhere. The collar defines what the agent can do, what requires approval, and what is blocked. Aegis provides protected browser sessions, sensitive action gating, temporary Runners, receipts, and reputation.

The wedge is protected browser sessions for outside agents.

The moat is the trust graph created from verified delegations, approvals, receipts, incidents, and outcomes.

As agents become disposable, Aegis becomes the durable trust layer behind them.

## One-Minute Pitch

AI agents are starting to act across the web, but today making them useful often means giving them too much authority.

Aegis gives users a safer way.

Instead of giving an agent your password, card, or ID, you give it an Aegis Pass with a customizable collar.

The agent can browse, search, compare, and draft freely. But when it tries to log in, pay, post, upload, submit, or share sensitive information, Aegis steps in.

Aegis checks the collar, asks for approval if needed, uses a temporary Runner to complete approved sensitive steps, and creates a receipt.

Over time, those receipts build reputation around verified delegation.

Agents are disposable. Trust is not.

## Thirty-Second Pitch

Aegis is the collar you put on AI agents before letting them act for you.

It lets agents browse freely, but gates sensitive actions like login, payment, posting, uploading, and identity sharing.

Instead of giving agents raw passwords or credit cards, users give them an Aegis Pass with customizable rules.

Agents ask. Aegis decides.

## Taglines

- Safely send AI agents into the world.
- The collar for autonomous agents.
- Give agents boundaries before they act for you.
- Do not give your agent your password. Give it an Aegis Pass.
- Agents can browse. Aegis decides when they can commit.
- Agents are disposable. Trust is not.
- Aegis lets agents use your authority without possessing your secrets.
- Platform IDs prove origin. AegisID proves trust.
- Verified people. Verified agents. Verified businesses. Verified actions.

## Core Lines To Preserve

- Agents are disposable. Trust is not.
- Aegis is the collar you put on AI agents before letting them act for you.
- Do not give your agent your password. Give it an Aegis Pass.
- Agents can browse. Aegis decides when they can commit.
- Outside agents plan. Aegis executes sensitive steps.
- Aegis lets agents use your authority without possessing your secrets.
- Aegis gives agents usable identity without exposing unnecessary identity.
- Platform IDs prove origin. AegisID proves trust.
- The ID is not the moat. The trust graph is the moat.
- Aegis lets people safely send AI agents into the world.


