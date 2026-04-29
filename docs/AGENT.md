# AGENT.md

## Purpose

This document defines how AI coding agents should understand and build Aegis.

Aegis is the trust and control layer for autonomous AI agents. It lets users attach identity, permissions, restrictions, approvals, receipts, and reputation to agents built anywhere.

Aegis is not an agent builder. Users should be able to use agents from ChatGPT, Claude, Gemini, OpenClaw-style browsers, custom MCP agents, or future platforms, then attach Aegis to those agents.

Aegis exists to make outside agents safer, more accountable, and more useful when they act on behalf of users.

## Core Thesis

Agents are disposable. Trust is not.

As agents become easier to create, users will constantly switch models, prompts, platforms, and runtimes. The durable layer should be the user’s verified identity, permissions, claims, receipts, and reputation history.

Aegis should become that durable layer.

## Core Product Metaphor

Aegis is the collar you put on an AI agent before letting it act for you.

A collar defines:

- who the agent is acting for
- what the agent is allowed to do
- what the agent is blocked from doing
- what requires human approval
- what identity claims the agent may use
- what credentials or capabilities it may request
- when the agent’s authority expires
- what receipts should be created

The collar should not be treated as a prompt or markdown instruction file. It should be implemented as a signed, revocable, enforceable permission object.

## Core Principle

Do not give agents raw secrets.

Agents should not directly receive:

- passwords
- credit card numbers
- full identity documents
- unrestricted OAuth tokens
- unrestricted browser sessions
- private files
- sensitive personal data

Instead, agents should receive an Aegis Pass that lets them request controlled capabilities from Aegis.

Core line:

> Do not give your agent your password. Give it an Aegis Pass.

## What Aegis Controls

Aegis should not try to control every thought, message, click, or page view.

Agents should be able to browse, research, compare, scroll, plan, and draft with minimal friction.

Aegis should step in at sensitive action boundaries, including:

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
- high-risk legal, financial, medical, or educational actions

Core line:

> Agents can browse. Aegis decides when they can commit.

## Security Model

Do not rely on prompts as the security boundary.

Prompts can guide agent behavior, but agents may misunderstand instructions, hallucinate, be prompt-injected, or attempt actions outside the user’s intent.

Aegis should enforce restrictions through external control points:

- Aegis Protected Sessions
- MCP or tool gateways
- OAuth/token controls
- credential vaulting
- temporary Aegis Runners
- approval flows
- signed collars
- revocation checks
- receipts

The model can think whatever it wants. Aegis controls what it can do.

## Aegis Pass

An Aegis Pass is what a user gives to an outside agent.

It should not contain raw credentials or sensitive information.

It should allow the agent to request:

- protected browser sessions
- limited capabilities
- verified identity claims
- website or business verification
- approval for sensitive actions
- temporary execution through Aegis Runners

The agent asks. Aegis decides.

## Aegis Protected Sessions

Aegis Protected Sessions are controlled browser sessions that allow agents to use the web while Aegis monitors for sensitive boundaries.

Preferred technical direction:

- Playwright/CDP-controlled Chromium sessions
- isolated browser contexts
- headless by default, visible on demand
- collar-bound sessions
- short-lived sessions
- event detection for login, payment, posting, uploads, submissions, and identity disclosure

Aegis should not require users to manually open a protected browser every time. Agents should be able to request protected sessions through Aegis when web access is needed.

However, Aegis can only enforce restrictions inside Aegis-controlled sessions or Aegis-integrated tools. If the user gives an outside agent raw credentials or an unrestricted browser, Aegis cannot reliably enforce the collar.

## Aegis Runners

Aegis Runners are temporary executors that complete sensitive steps without exposing secrets to the outside agent.

Examples:

- log into a site without exposing the password
- complete an approved payment with a virtual or controlled payment method
- publish an approved post
- send an approved email
- disclose a verified claim such as student or employee status
- upload an approved file
- complete a form submission after approval

Runners should be:

- short-lived
- narrowly scoped
- collar-bound
- logged
- terminated after completion

Core line:

> Outside agents plan. Aegis executes sensitive steps.

## Aegis Vault

Aegis may store or connect to sensitive authority, including:

- passwords
- OAuth tokens
- payment methods
- verified identity claims
- student verification
- employee verification
- business verification
- trusted contacts

However, Aegis should not be positioned as only a password manager.

The vault is infrastructure. The product is controlled agent authority.

Core line:

> Aegis turns secrets into controlled capabilities.

## AegisID

AegisID is the durable identity and reputation layer behind users, agent sessions, businesses, websites, and APIs.

AegisID may represent:

- User AegisID
- Agent Session AegisID
- Business AegisID
- Website AegisID
- API AegisID

AegisID should support reusable verified claims such as:

- verified human
- verified student
- verified employee
- verified adult
- verified guardian
- verified business
- verified domain

Verified claims should use minimal disclosure. Aegis should prove what is necessary without exposing unnecessary personal information.

Example:

Aegis should allow an agent to prove “verified student” without revealing the user’s full ID, student number, or unrelated personal data.

## Business and Website Trust

Aegis should support business and website verification later.

A verified business or website should be able to prove:

- domain ownership
- legal business existence
- agent interaction policy
- data handling expectations
- refund or dispute policy when relevant
- prompt-injection or incident history
- agent-safe status

This creates a two-sided trust handshake:

- agents prove who they represent and what they are allowed to do
- businesses prove they are verified and safe to interact with

Aegis decides whether the interaction should proceed, be restricted, require approval, or be blocked.

## Reputation

Reputation is likely the long-term moat.

However, Aegis should not become a surveillance product or universal social credit score.

Reputation should be built from trust-relevant receipts, not constant tracking.

Track events such as:

- collar creation
- protected session start
- sensitive capability request
- user approval or denial
- sensitive action completion
- verified business interaction
- prompt-injection report
- collar violation attempt
- user dispute
- business dispute
- revoked or expired collar use attempt

Do not track every click, page, token, private message, or browsing action by default.

Reputation should be:

- category-specific
- explainable
- privacy-preserving
- based on outcomes
- decayed over time
- attached mainly to durable AegisID, not disposable agents

Core line:

> Aegis reputation is not a score of who you are. It is a history of how safely your agents act under verified delegation.

## MVP Scope

The first MVP should prove one core loop.

Recommended MVP:

- create an Aegis Pass
- attach a Shopping Collar
- allow an outside agent to request an Aegis Protected Session
- let the agent browse freely
- detect checkout, payment, login, post, upload, submit, or identity boundaries
- require user approval for purchase
- use an Aegis Runner to complete approved sensitive action
- create a receipt
- record basic reputation signals

Do not build the full platform first.

Avoid starting with:

- full password manager
- full government ID verification
- universal website verification
- agent marketplace
- insurance
- family mode
- elder mode
- complete reputation graph
- enterprise admin console

These are future expansions.

## Development Guidance

When building Aegis, prioritize:

1. Clear separation between agent planning and Aegis-controlled action.
2. Minimal disclosure of sensitive data.
3. Enforcement at browser, tool, token, and approval boundaries.
4. Simple collar presets before complex custom policy.
5. Receipts for trust-relevant events.
6. User approval only when risk crosses a meaningful threshold.
7. Architecture that works with outside agents rather than replacing them.

Avoid building features that make Aegis feel like:

- another agent builder
- a generic password manager
- a surveillance dashboard
- a prompt-only safety system
- a browser automation toy
- a universal identity score

## Product Lines To Preserve

- Agents are disposable. Trust is not.
- Aegis is the collar you put on AI agents before letting them act for you.
- Do not give your agent your password. Give it an Aegis Pass.
- Agents can browse. Aegis decides when they can commit.
- Outside agents plan. Aegis executes sensitive steps.
- Aegis lets agents use your authority without possessing your secrets.
- Aegis gives agents usable identity without exposing unnecessary identity.
- Aegis reputation is a history of how safely your agents act under verified delegation.

