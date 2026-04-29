# AEGISID.md

## Purpose

This document defines AegisID.

AegisID is the durable identity, verification, delegation, and reputation layer behind Aegis.

Agents are disposable. AegisID is durable.

AegisID should let users, agents, businesses, websites, and APIs prove who they are, what they are allowed to do, what claims they can make, and what reputation history exists around their agent-mediated actions.

Core line:

> Platform IDs prove origin. AegisID proves trust.

## Core Thesis

As AI agents become easier to create, users will constantly switch between agents, models, prompts, platforms, and runtimes.

A single agent instance should not be the primary holder of trust.

The durable trust layer should be the AegisID behind the agent.

AegisID should answer:

- Who is this agent acting for?
- Is there a verified person or organization behind it?
- What did that person authorize?
- What identity claims can be safely disclosed?
- What website, business, or API is the agent interacting with?
- Is that counterparty verified?
- What reputation history exists for this type of interaction?
- What happened if something went wrong?

## What AegisID Is

AegisID is a verifiable identity and trust credential layer.

It can represent:

- users
- agent sessions
- businesses
- websites
- APIs
- organizations
- verified claims
- delegations

AegisID should not be treated as one generic profile.

It should be a structured identity layer with different ID types and different trust claims.

## AegisID Types

### 1. User AegisID

Represents a real user or organization behind an agent.

A User AegisID can hold:

- verified human status
- verified email
- verified phone
- verified student status
- verified employee status
- verified adult status
- verified guardian relationship
- verified business owner status
- trusted devices
- trusted contacts
- reputation history
- approval preferences
- collar history
- receipt history

The User AegisID is durable.

Agents may change. The user’s AegisID remains.

### 2. Agent Session AegisID

Represents a specific temporary agent session.

An Agent Session AegisID can include:

- backing User AegisID
- active Aegis Pass
- active collar
- task purpose
- allowed capabilities
- expiration
- session status
- protected browser session ID
- current risk state
- receipt references

Agent Session AegisIDs should usually be short-lived.

They should expire when the task ends, the collar expires, or the user revokes access.

### 3. Business AegisID

Represents a verified business.

A Business AegisID can include:

- legal business verification
- domain ownership
- business category
- support contact
- dispute contact
- agent interaction policy
- refund or cancellation policy when relevant
- prompt-injection reports
- incident history
- dispute history
- verified trust tier

Business AegisID is important because users and agents need to know whether a website or company is real and safe to interact with.

### 4. Website AegisID

Represents a verified website or domain.

A Website AegisID can include:

- verified domain ownership
- associated Business AegisID
- agent policy URL
- allowed agent actions
- blocked agent actions
- data handling expectations
- known incident reports
- prompt-injection history
- current trust state

A website may be verified at the domain level even before the full business verification is complete, but higher-risk interactions should require stronger verification.

### 5. API AegisID

Represents an API or tool endpoint.

An API AegisID can include:

- verified owner
- supported agent actions
- required scopes
- rate limits
- data handling rules
- incident history
- supported Aegis verification methods
- supported receipt generation

This becomes important for MCP tools, SaaS APIs, and agent-facing services.

## Reusable Verified Claims

AegisID should support reusable verified claims.

A verified claim is a reusable proof about a user, business, or website.

Examples:

- verified human
- verified student
- verified employee
- verified adult
- verified guardian
- verified local resident
- verified veteran
- verified professional license holder
- verified business
- verified domain
- verified API owner

These claims should be disclosed minimally.

The goal is not to reveal raw identity everywhere.

The goal is to prove only what is necessary.

Core line:

> Aegis gives agents usable identity without exposing unnecessary identity.

## Minimal Disclosure

AegisID should avoid exposing unnecessary personal information.

Example:

If a website only needs to know that the user is a student, Aegis should not reveal:

- full legal name
- student ID number
- date of birth
- transcript
- school records
- address
- unrelated identity claims

It should reveal a limited claim:

- verified_student: true
- claim issuer
- claim freshness
- expiration if relevant
- disclosure level

Example claim:

{
  "claim": "verified_student",
  "status": "verified",
  "issuer": "trusted_verification_provider",
  "disclosure": "claim_only",
  "expires_at": "2027-01-01T00:00:00Z"
}

## Claim Disclosure Levels

Aegis should support different levels of claim disclosure.

### Claim-only disclosure

Only reveals that the claim is true.

Example:

- verified student: true
- over 18: true
- verified human: true

### Attribute disclosure

Reveals limited attributes.

Example:

- school: University of Michigan
- employer: Google
- age range: over 18
- state: Michigan

### Full disclosure

Reveals stronger identity information.

Example:

- legal name
- full date of birth
- address
- government ID verification result

Full disclosure should be rare and should usually require explicit approval.

## AegisID and Collars

AegisID stores durable claims and reputation.

Collars define what an agent session may use.

Example:

A User AegisID may contain:

- verified human
- verified student
- verified employee
- verified adult

But a specific collar may allow only:

- verified student

and block:

- verified employee
- legal name
- full identity disclosure

AegisID is the vault of trust claims.

The collar is the permission boundary for using those claims.

## AegisID and Aegis Pass

An Aegis Pass lets an outside agent request access to Aegis-controlled capabilities.

AegisID defines the durable identity behind those capabilities.

Example:

The pass says:

- this agent can request Aegis services

The collar says:

- this agent may request verified student claim with approval

The AegisID says:

- this user actually has a verified student claim

The policy engine decides:

- allow
- approval required
- block

## Verified Delegation

The most important primitive is not identity alone.

The most important primitive is verified delegation.

Verified delegation means:

> A real verified person or organization authorized this agent to perform this specific task under these specific limits.

A verified delegation should include:

- backing User AegisID
- Agent Session AegisID
- active collar
- task purpose
- allowed actions
- blocked actions
- approval requirements
- expiration
- revocation status

Core line:

> AegisID is not just who you are. It is what you authorized an agent to do.

## Example Verified Delegation

{
  "type": "verified_delegation",
  "delegation_id": "dlg_123",
  "user_aegis_id": "aid_user_123",
  "agent_session_id": "aid_session_456",
  "collar_id": "collar_789",
  "task": "Find and optionally purchase running shoes under $100",
  "allowed_actions": [
    "browse",
    "search",
    "compare",
    "add_to_cart"
  ],
  "approval_required": [
    "purchase",
    "payment",
    "share_email",
    "submit_shipping_address"
  ],
  "blocked_actions": [
    "buy_subscription",
    "save_payment_method",
    "upload_government_id"
  ],
  "expires_at": "2026-04-27T00:00:00Z",
  "status": "active"
}

## Business and Website Verification

AegisID should eventually support business and website verification.

A business can verify itself by proving:

- domain ownership
- legal business existence
- authorized representative
- support or dispute contact
- agent interaction policy
- data handling commitments

A website can verify itself by proving:

- domain ownership
- association with verified business
- official agent policy
- supported agent actions
- no known unresolved high-risk incidents

## Agent Policy Discovery

Websites and businesses may eventually publish an Aegis policy file.

Example path:

/.well-known/aegis-agent-policy.json

This file can tell agents:

- whether agents are allowed
- what actions are allowed
- what actions are blocked
- what requires user approval
- what AegisID represents the business or website
- where to verify the policy

Important:

A policy file alone is not enough.

Aegis must still verify that the domain and business are legitimate.

## Two-Sided Trust Handshake

AegisID enables a two-sided trust handshake.

### Agent side proves:

- this agent is backed by a User AegisID
- the user is verified if required
- the agent has an active collar
- the agent is authorized for this task
- the agent may disclose only specific claims
- sensitive actions require approval

### Business or website side proves:

- this domain is verified
- this business is real
- this website supports agent interaction
- this website has a published policy
- this website has acceptable reputation
- this website has no disqualifying incidents

### Aegis decides:

- proceed
- proceed with restrictions
- require approval
- block
- report incident

Core line:

> Verified people. Verified agents. Verified businesses. Verified actions.

## AegisID Reputation

AegisID should accumulate reputation from trust-relevant receipts.

Reputation should not be a universal social credit score.

Reputation should be:

- action-specific
- category-specific
- explainable
- privacy-preserving
- decayed over time
- based on outcomes
- based on verified delegation

Examples:

- shopping history: established and clean
- travel history: limited but clean
- identity disclosure history: no incidents
- payment dispute rate: low
- prompt injection reports against business: none recent
- business dispute rate: low

AegisID reputation should mostly attach to durable identities, not disposable agent instances.

Example:

Agents backed by this AegisID have completed 18 shopping interactions with verified businesses and no disputes.

## What AegisID Should Not Become

AegisID should not become:

- a universal social credit score
- a public morality score
- a surveillance profile
- a replacement for all identity providers
- a raw government ID database
- a way to expose full user identity everywhere
- a guarantee that no agent can fail
- a legal liability judge

AegisID creates verifiable delegation, trust claims, receipts, and reputation signals.

It does not determine final legal liability.

Core line:

> Aegis does not decide liability. Aegis preserves evidence of delegation, approval, policy, and action.

## Privacy Principles

AegisID must be privacy-preserving by default.

Principles:

- minimize raw data storage
- disclose only necessary claims
- avoid exposing full identity when a claim is enough
- avoid tracking unrelated behavior
- allow users to revoke agent access
- allow users to see what claims were disclosed
- support expiration for claims and delegations
- keep receipts focused on trust-relevant facts
- separate private user data from public reputation signals

## Trust Claim Examples

### Verified human

Proves the agent is backed by a real person.

Does not reveal full identity by default.

### Verified student

Proves the user has student status.

Can be used for student discounts, school access, and eligibility checks.

Should not reveal student number or school records unless explicitly required and approved.

### Verified employee

Proves the user is associated with an employer.

Useful for employee benefits, work tools, and company-specific access.

Should not reveal internal company data.

### Verified adult

Proves age eligibility.

Should not reveal full birthday unless required and approved.

### Verified guardian

Proves a guardian relationship.

Useful for child agent controls and approvals.

### Verified business

Proves the company exists and has passed verification.

Useful for websites, marketplaces, APIs, and agent interactions.

### Verified domain

Proves control of a domain.

Useful for website trust and policy discovery.

## Public vs Private Claims

Not every AegisID claim should be public.

### Private claims

Visible only to the user and Aegis unless disclosed through a collar.

Examples:

- verified student
- verified employee
- verified adult
- legal name verification
- trusted contacts
- approval settings

### Shared claims

Disclosed to websites, APIs, or businesses when allowed by a collar.

Examples:

- verified student: true
- verified human-backed delegation
- purchase approved
- action allowed under collar

### Public claims

Potentially visible in public trust contexts.

Examples:

- business verified
- domain verified
- agent-safe policy published
- high-level trust tier
- unresolved incident warning

## AegisID Lifecycle

### 1. Create

A user, business, website, or API creates an AegisID.

### 2. Verify

The identity may be verified through:

- email
- phone
- domain records
- OAuth
- trusted identity providers
- business verification providers
- student or employee verification providers
- future verifiable credentials

### 3. Attach Claims

Verified claims are attached to the AegisID.

### 4. Delegate

A user creates an Aegis Pass and collar for an agent session.

### 5. Act

The agent acts through Aegis-controlled sessions or tools.

### 6. Record

Trust-relevant receipts are created.

### 7. Update Reputation

Reputation signals update based on outcomes.

### 8. Revoke or Expire

Claims, passes, collars, sessions, and delegations can expire or be revoked.

## MVP AegisID Scope

For MVP, keep AegisID simple.

Required:

- User AegisID
- Agent Session AegisID
- basic Aegis Pass link
- basic collar connection
- basic receipt connection

Optional mock claims:

- verified human
- verified student
- verified business

Not required for MVP:

- real government ID verification
- real student verification
- full business verification
- real public trust badge
- cross-platform identity aggregation
- full reputation graph
- legal-grade receipts

## MVP Data Model

### User AegisID

{
  "id": "aid_user_123",
  "type": "user",
  "email": "user@example.com",
  "verified_claims": [],
  "created_at": "2026-04-26T00:00:00Z"
}

### Agent Session AegisID

{
  "id": "aid_session_456",
  "type": "agent_session",
  "user_aegis_id": "aid_user_123",
  "aegis_pass_id": "pass_123",
  "collar_id": "collar_789",
  "status": "active",
  "expires_at": "2026-04-27T00:00:00Z"
}

### Business AegisID

{
  "id": "aid_business_123",
  "type": "business",
  "name": "Example Business",
  "domain": "example.com",
  "domain_verified": true,
  "business_verified": false,
  "agent_policy_url": "https://example.com/.well-known/aegis-agent-policy.json"
}

## Future Directions

Future AegisID features may include:

- real identity verification
- student verification
- employee verification
- reusable verified claims
- selective disclosure
- business verification
- website trust badges
- public Aegis trust profiles
- prompt injection incident history
- dispute resolution records
- enterprise identity integrations
- integration with Okta, Cloudflare, Stripe Identity, Persona, and other identity providers
- decentralized or portable credentials
- agent platform trust aggregation

## Core Lines To Preserve

- Agents are disposable. Trust is not.
- Platform IDs prove origin. AegisID proves trust.
- Aegis gives agents usable identity without exposing unnecessary identity.
- AegisID is not just who you are. It is what you authorized an agent to do.
- Verified people. Verified agents. Verified businesses. Verified actions.
- Aegis does not decide liability. Aegis preserves evidence of delegation, approval, policy, and action.
- Reputation should attach to durable AegisID, not disposable agent instances.

