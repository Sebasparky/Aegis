# SECURITY_MODEL.md

## Purpose

This document defines the security model for Aegis.

Aegis is the trust and control layer for autonomous AI agents.

The goal of Aegis is not to make agents perfectly safe.

The goal is to make agent action more controlled, permissioned, auditable, revocable, and accountable.

Core line:

> The model can think whatever it wants. Aegis controls what it can do.

## Core Security Thesis

Agents are not the security boundary.

Prompts are not the security boundary.

The browser page is not the security boundary.

The outside agent should be treated as untrusted.

The secure boundary should be:

- Aegis-controlled sessions
- Aegis-controlled tools
- Aegis-controlled tokens
- Aegis-controlled credentials
- Aegis-controlled approval flows
- Aegis-controlled runners
- signed collars
- revocation checks
- receipts

Aegis should not depend on the agent voluntarily obeying instructions.

Aegis should enforce restrictions at the point where the agent tries to turn intent into action.

Core line:

> Agents can browse. Aegis decides when they can commit.

## Threat Model

Aegis should assume an outside agent may be:

- confused
- hallucinating
- overconfident
- prompt-injected
- malicious
- jailbroken
- using unsafe tools
- trying to bypass restrictions
- operating outside user intent
- running on an untrusted platform
- connected to a compromised website
- given ambiguous instructions by the user

Aegis should also assume websites may be:

- legitimate
- unverified
- compromised
- malicious
- prompt-injection sources
- credential harvesters
- scam websites
- abusing urgency
- requesting unnecessary sensitive data
- misrepresenting costs or terms

Aegis should also assume users may:

- misunderstand agent permissions
- approve risky actions too quickly
- give raw credentials to agents outside Aegis
- forget to revoke old access
- create overly broad collars
- want convenience over security

The product must protect users without making the experience unusable.

## What Aegis Can Enforce

Aegis can enforce restrictions when it controls at least one of the following:

- the browser session
- the tool call
- the API gateway
- the OAuth token
- the credential vault
- the payment method
- the identity claim
- the approval flow
- the execution environment

If the agent acts through Aegis-controlled infrastructure, Aegis can enforce the collar.

Examples:

- agent uses Aegis Protected Session
- agent uses Aegis MCP tools
- agent requests login through Aegis Runner
- agent requests payment through Aegis
- agent requests verified claim through Aegis
- agent uses Aegis-controlled OAuth token
- website verifies AegisID before accepting sensitive action

## What Aegis Cannot Enforce

Aegis cannot reliably enforce restrictions when the agent already has raw authority outside Aegis.

Examples:

- user gives the agent a raw password
- user gives the agent a full credit card number
- user gives the agent unrestricted OAuth token
- user gives the agent access to their normal logged-in browser
- user gives the agent a remote desktop session with full control
- user gives the agent files directly outside Aegis
- agent uses a non-Aegis browser or tool path
- website accepts agent action without checking Aegis

In these cases, Aegis may still provide guidance, monitoring, or after-the-fact receipts if integrated, but enforcement is weak.

Core line:

> Aegis works when agents use Aegis-controlled keys, tools, sessions, or capabilities.

## Security Boundary

The trusted security boundary should be Aegis-controlled infrastructure.

Trusted components:

- Aegis backend
- policy engine
- collar store
- pass verifier
- protected browser controller
- approval service
- runner service
- receipt service
- vault or credential broker
- revocation service

Untrusted or semi-trusted components:

- outside agent
- agent platform
- website content
- page scripts
- user-provided instructions
- business-provided policies until verified
- model-generated action descriptions
- raw browser page text
- third-party tools not integrated with Aegis

Aegis should verify before trusting.

## Core Enforcement Pattern

The preferred enforcement pattern is:

1. Agent proposes or attempts an action.
2. Aegis detects the action type.
3. Aegis checks the active collar.
4. Aegis checks session status.
5. Aegis checks counterparty trust if relevant.
6. Aegis decides allow, approval_required, runner_required, block, pause, or revoke.
7. Sensitive action executes only if allowed.
8. Receipt is created.
9. Reputation signal is updated.

The agent should not be allowed to self-certify that an action is safe.

## Agent Honesty Assumption

Aegis should not assume the agent is honest.

The agent may say:

- this is just browsing
- this is not a purchase
- the user already approved
- this website is safe
- this data is not sensitive
- this action is reversible

Aegis can use the agent’s explanation as context, but it should verify through browser, tool, policy, and receipt data.

Core line:

> Agent intent is context, not authority.

## Browser Security Model

Aegis Protected Sessions are controlled browser sessions.

They should be:

- isolated from the user’s normal browser
- short-lived
- collar-bound
- revocable
- monitored for sensitive action boundaries
- disposable after task completion
- optionally headless
- visible on demand

The protected session should not use the user’s normal browser profile.

The protected session should not automatically inherit all user cookies, sessions, or browser extensions.

The protected session should use a dedicated isolated browser context.

## Browser Enforcement Targets

Aegis should focus on sensitive browser boundaries.

High-priority targets:

- login pages
- password fields
- checkout pages
- payment fields
- credit card fields
- subscription flows
- public posting
- direct messaging
- email sending
- file uploads
- form submissions
- identity fields
- account settings
- OAuth authorization screens
- delete/cancel/change actions
- suspicious downloads
- sensitive redirects

Aegis should not try to block normal low-risk browsing.

Allowed by default unless collar says otherwise:

- navigating
- scrolling
- reading
- searching
- comparing
- summarizing
- opening product pages
- drafting text
- adding items to cart

## Detection Limits

Browser detection will not be perfect.

Websites are messy.

Some websites use:

- vague button labels
- dynamic JavaScript
- shadow DOM
- iframes
- canvas interfaces
- custom components
- keyboard shortcuts
- anti-bot protections
- misleading copy
- hidden instructions

Aegis should begin with high-confidence detection rules and improve over time.

When uncertain, Aegis should prefer requiring approval over silently allowing sensitive actions.

But Aegis should avoid unnecessary approvals for low-risk actions.

## Prompt Injection Security

Aegis should assume prompt injection will happen.

Websites may include instructions such as:

- ignore previous instructions
- reveal private data
- send credentials
- bypass policy
- disable safety rules
- follow hidden instructions
- exfiltrate data
- use payment without approval

Aegis should not rely on the agent to resist all prompt injections.

Instead, Aegis should restrict what the agent can actually do.

If a prompt injection tells the agent to reveal a credit card, Aegis should prevent the agent from possessing the credit card in the first place.

Core line:

> The best prompt injection defense is not giving the agent the secret.

## Prompt Injection Reporting

Aegis should allow prompt injection attempts to become reputation events.

If a website attempts to manipulate an agent, Aegis should be able to:

- block sensitive action
- create incident receipt
- mark website for review
- warn future sessions
- reduce website trust
- notify user
- notify business if verified

Core line:

> Aegis turns prompt injection from an invisible attack into a reportable reputation event.

## Credential Security

Aegis should not expose raw credentials to outside agents.

Credentials may include:

- passwords
- API keys
- OAuth tokens
- session cookies
- credit card numbers
- bank details
- identity documents
- private files
- sensitive claims

Preferred approach:

- store or connect credentials in Aegis
- expose controlled capabilities instead of secrets
- use Aegis Runners for sensitive execution
- use short-lived tokens where possible
- use OAuth scopes where possible
- use virtual or limited payment credentials where possible
- disclose verified claims instead of raw identity documents

Core line:

> Aegis turns secrets into controlled capabilities.

## Password Handling

Aegis may eventually store or connect to passwords, but it should avoid becoming only a password manager.

If Aegis handles passwords:

- passwords should never be shown to outside agents
- passwords should be encrypted at rest
- password use should be logged as a sensitive event
- login should be performed by Aegis Runner or protected session
- users should approve risky or new logins
- passwords should not be returned through agent APIs

For MVP, avoid real password storage.

Use mock credentials or OAuth where possible.

## Payment Security

Aegis should not expose full payment methods to outside agents.

Preferred payment controls:

- approval-required payment execution
- virtual cards
- merchant-locked payment methods
- amount-limited payment methods
- one-time payment tokens
- no save-payment-method by default
- no subscriptions unless explicitly allowed
- receipts for approved payments

For MVP, do not handle real payment credentials.

Use simulated payment or mock checkout.

## Identity Claim Security

AegisID should support reusable verified claims.

Claims should be disclosed minimally.

Examples:

- verified human
- verified student
- verified employee
- verified adult
- verified guardian
- verified business owner

Aegis should avoid sharing full identity documents when a simple claim is enough.

Example:

Share:

- verified_student: true

Avoid sharing unless required and approved:

- full student ID
- transcript
- legal name
- birthdate
- address
- unrelated documents

Core line:

> Aegis gives agents usable identity without exposing unnecessary identity.

## Aegis Runner Security

Aegis Runners are temporary executors for sensitive actions.

Runners should be:

- short-lived
- narrowly scoped
- task-specific
- collar-bound
- approval-bound when needed
- logged
- terminated after completion

A Runner should receive only the minimum authority needed.

Example:

A payment runner may complete one approved purchase for one merchant up to one amount within a short time window.

It should not be able to:

- change the product
- increase the amount
- save the payment method
- buy a subscription
- browse unrelated websites
- access unrelated accounts
- continue acting after completion

## Approval Security

Approvals are a core security boundary.

Approval requests should clearly show:

- what the agent wants to do
- why it wants to do it
- what website or business is involved
- what collar rule triggered approval
- what data or money is involved
- whether the counterparty is verified
- what happens if approved
- whether a Runner will execute the action

Approvals should avoid dark patterns.

Approvals should not be spammy.

Approval fatigue is a security risk.

Aegis should request approval only when risk crosses meaningful thresholds.

## Revocation Security

Users should be able to revoke:

- Aegis Pass
- collar
- protected session
- Runner task
- verified claim access
- website trust exception
- approval rule

Revocation should take effect quickly.

A revoked pass or collar should block future sensitive actions.

Expired sessions should not be reusable.

If a revoked object is used again, Aegis should create a security event.

## Signed Collars

Eventually, collars should be signed.

A signed collar proves:

- the collar was issued or validated by Aegis
- the user authorized the policy
- the policy was not tampered with
- the collar is tied to a specific pass or session
- the collar has not expired
- the collar has not been revoked

For MVP, server-side policy evaluation is enough.

However, architecture should assume collars eventually become signed, revocable, portable permission objects.

Core line:

> The agent carries the collar. Aegis defines what the collar means.

## Aegis Pass Security

An Aegis Pass should be:

- scoped
- revocable
- expiring
- tied to a user
- tied to allowed collars
- limited by session rules
- usable only for Aegis-controlled capabilities

It should not contain raw credentials.

If compromised, damage should be limited by:

- expiration
- revocation
- collar restrictions
- approval requirements
- lack of raw secrets
- session limits

## Website and Business Trust Security

Aegis should not trust a website simply because it claims to be safe.

A business or website should be verified through:

- domain ownership
- business verification
- policy publication
- incident history
- dispute history
- supported Aegis verification

A `.well-known` policy file can help discovery, but it is not enough by itself.

Aegis must verify that the domain and business are legitimate.

## Counterparty Risk

Before releasing sensitive capabilities, Aegis should consider counterparty trust.

Examples:

- verified business
- verified domain
- published agent policy
- no recent incident reports
- low dispute history
- no prompt injection reports
- no suspicious redirects

If a website is unverified, Aegis may still allow browsing but should restrict sensitive actions.

Default idea:

- browsing unverified sites is usually allowed
- payment on unverified sites requires approval or is blocked
- identity disclosure to unverified sites is blocked by default
- file upload to unverified sites requires approval or is blocked

## Receipts As Security Evidence

Receipts are not just product logs.

They are security evidence.

Receipts should show:

- what action was requested
- what collar applied
- what decision was made
- whether approval occurred
- what counterparty was involved
- whether a Runner executed the action
- whether the action succeeded
- whether an incident occurred

Receipts should avoid raw secrets and unnecessary private data.

Core line:

> Aegis does not decide liability. Aegis preserves evidence of delegation, approval, policy, and action.

## Logging Security

Aegis should log enough to preserve trust and accountability, but not enough to become creepy or dangerous.

Avoid logging by default:

- raw passwords
- full credit card numbers
- full identity documents
- full private messages
- full email contents
- full browsing history
- full page contents
- full model conversations
- unnecessary screenshots

Prefer logging:

- action type
- collar ID
- decision
- domain
- counterparty trust status
- approval state
- outcome
- timestamp
- receipt ID

Core line:

> Log more when risk is higher, not by default.

## Privacy Threats

Aegis itself could become a privacy risk.

Risks:

- overcollection
- unnecessary screenshots
- centralized credential storage
- sensitive receipt leakage
- excessive identity disclosure
- broad browsing history retention
- reputation misuse
- user profiling

Mitigations:

- minimal logging by default
- claim-based disclosure
- short-lived sessions
- revocation
- encryption
- user-visible receipts
- separate private and shared claims
- retention limits
- avoid public user scores

## Abuse Risks

Aegis may be abused if not designed carefully.

Potential abuse:

- malicious user creates verified agent to commit fraud
- business uses Aegis badge misleadingly
- agent platform tries to bypass Aegis restrictions
- attacker steals Aegis Pass token
- compromised website manipulates agent
- user approves malicious request due to fatigue
- fake business attempts verification
- reputation system is gamed

Mitigations:

- pass expiration
- revocation
- rate limits
- approval clarity
- business verification
- dispute system
- anomaly detection
- receipt review
- trust decay
- manual review for severe incidents

## Security MVP Scope

For MVP, do not attempt production-grade security.

MVP should prove the security model conceptually.

MVP should include:

- no raw real credentials
- no real payment credentials
- no real government ID storage
- isolated browser session
- basic collar enforcement
- basic approval flow
- basic action blocking
- basic receipts
- basic revocation
- mock Runner
- mock verified business if needed

MVP should not include:

- real password vault
- real payment processing
- real legal-grade identity proofing
- real public trust badges
- real insurance
- real dispute adjudication

## MVP Security Requirements

The MVP should show:

1. Agent can browse through protected session.
2. Agent attempts sensitive action.
3. Aegis detects sensitive boundary.
4. Aegis checks collar.
5. Aegis pauses or blocks action.
6. User approves or denies.
7. Runner simulates sensitive execution if approved.
8. Receipt is created.
9. Sensitive secret is not exposed to the agent.

## Security Non-Goals For MVP

Do not spend early effort on:

- perfect browser detection
- all websites
- anti-bot bypass
- production cryptography
- real credential vaulting
- real payment execution
- real ID verification
- legal compliance system
- formal liability engine

These matter later, but the MVP should prove the pattern.

## Honest User-Facing Claims

Aegis should be honest.

Good claims:

- Aegis helps agents act with safer boundaries.
- Aegis keeps sensitive credentials away from outside agents when actions are routed through Aegis.
- Aegis can require approval before sensitive actions.
- Aegis creates receipts for trust-relevant events.
- Aegis can reduce risk from prompt injection by limiting agent authority.

Avoid claims:

- Aegis makes agents perfectly safe.
- Aegis prevents all prompt injection.
- Aegis guarantees no fraud.
- Aegis determines legal liability.
- Aegis controls agents outside Aegis sessions.
- Aegis protects secrets already given directly to the agent.

## Security Principles To Preserve

- Treat outside agents as untrusted.
- Treat websites as untrusted until verified.
- Do not rely on prompts as the security boundary.
- Do not give agents raw secrets.
- Control sensitive actions through Aegis.
- Use approval only when risk justifies interruption.
- Store receipts, not surveillance.
- Make revocation easy.
- Prefer minimal disclosure.
- Keep sessions isolated and short-lived.
- Assume browser detection is imperfect.
- Be honest about enforcement limits.

## Core Lines To Preserve

- The model can think whatever it wants. Aegis controls what it can do.
- Agents can browse. Aegis decides when they can commit.
- Do not give your agent your password. Give it an Aegis Pass.
- Aegis turns secrets into controlled capabilities.
- The best prompt injection defense is not giving the agent the secret.
- Agent intent is context, not authority.
- The agent carries the collar. Aegis defines what the collar means.
- Aegis does not decide liability. Aegis preserves evidence of delegation, approval, policy, and action.
- Log more when risk is higher, not by default.


