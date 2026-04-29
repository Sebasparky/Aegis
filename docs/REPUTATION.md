# REPUTATION.md

## Purpose

This document defines Aegis reputation.

Reputation is the long-term moat of Aegis.

Aegis reputation should help users, agents, websites, businesses, APIs, and tools decide whether an agent-mediated interaction is safe, restricted, approval-worthy, or blocked.

Reputation must be designed carefully.

Aegis should not become a surveillance product.

Aegis should not become a universal social credit score.

Aegis should not track everything an agent does.

Aegis should track trust-relevant moments that prove how safely agents act under verified delegation.

Core line:

> Aegis reputation is not a score of who you are. It is a history of how safely your agents act under verified delegation.

## Core Thesis

Agents are disposable. Trust is not.

Users will constantly create, modify, replace, and abandon agents.

A single agent instance should not be the main holder of long-term reputation.

The durable reputation should attach primarily to AegisID.

Aegis should be able to say things like:

- agents backed by this AegisID have completed shopping tasks safely
- this AegisID has a clean history of approved purchases
- this business has low dispute history with agent interactions
- this website has prompt-injection reports
- this agent session attempted to exceed its collar
- this collar has prevented sensitive data leaks
- this protected session completed with no incidents

Reputation should be based on receipts, not vibes.

## What Reputation Is

Aegis reputation is a set of trust signals created from verified agent-mediated actions.

It should answer questions like:

- Has this AegisID safely delegated similar tasks before?
- Has this business handled agent interactions safely before?
- Has this website triggered prompt-injection reports?
- Has this agent session attempted to bypass restrictions?
- Has this collar produced too many approvals or blocks?
- Has this user disputed previous agent actions?
- Has this merchant created disputes with Aegis-backed users?
- Should this action proceed, require approval, or be blocked?

Reputation should help make better decisions at sensitive action boundaries.

## What Reputation Is Not

Aegis reputation is not:

- a universal morality score
- a social credit system
- a public ranking of people
- a complete browsing history
- a record of every click
- a record of every token
- a replacement for legal liability
- a guarantee that no agent or business will fail
- a reason to expose private user data

Reputation is a trust history for delegated agent actions.

## Core Design Principles

### 1. Track trust-relevant events only

Aegis should not track everything by default.

Track events where trust, authority, approval, identity, payment, safety, or accountability matter.

### 2. Store receipts, not surveillance

Reputation should be built from receipts.

A receipt records the minimum necessary facts around a trust-relevant event.

### 3. Make reputation category-specific

Do not create one universal score.

Trust should be specific to action categories.

Example:

A user may have strong shopping reputation but no finance reputation.

A business may be safe for browsing but not trusted for identity upload.

### 4. Make reputation explainable

Aegis should be able to explain why an action was allowed, blocked, or escalated.

Example:

“Approval required because this is the first purchase from this merchant.”

Example:

“Blocked because this website is unverified and requested government ID.”

### 5. Preserve privacy

Reputation should not expose unnecessary personal details.

Store categories and outcomes, not raw secrets or full private content.

### 6. Decay over time

Old events should matter less than recent events.

Users, agents, and businesses should be able to recover trust through clean behavior.

### 7. Attach durable reputation to AegisID

Agent instances are temporary.

Durable reputation should attach mostly to:

- User AegisID
- Business AegisID
- Website AegisID
- API AegisID
- Agent platform or developer identity when relevant

## Reputation Entities

Aegis may track reputation for several entity types.

### 1. User AegisID Reputation

Tracks how safely agents backed by a user’s AegisID act under delegation.

Examples:

- clean shopping history
- clean travel booking history
- low dispute rate
- safe identity disclosure history
- reliable approval behavior
- no known payment abuse
- no known repeated collar bypass attempts

This should not become a broad score of the user as a person.

It is a history of agent-mediated delegation behavior.

### 2. Agent Session Reputation

Tracks short-term behavior of a specific active agent session.

Examples:

- attempted blocked action
- repeated approval requests
- suspicious website navigation
- prompt-injection exposure
- session revoked
- session completed cleanly

Agent session reputation is useful for live risk scoring, but it is not the durable moat by itself.

### 3. Collar Reputation

Tracks how well a collar performs.

Examples:

- how many risky actions it blocks
- how often it creates annoying approvals
- how often users override it
- whether it causes false positives
- whether it prevents actual incidents
- whether it needs better defaults

This helps improve collar templates and customization.

### 4. Business AegisID Reputation

Tracks how safely a verified business interacts with agents and users.

Examples:

- low dispute rate
- successful agent interactions
- clear agent policy
- no prompt-injection reports
- no unnecessary identity requests
- responsive dispute handling
- refund or cancellation behavior

### 5. Website AegisID Reputation

Tracks domain-level safety.

Examples:

- domain verified
- associated business verified
- agent policy published
- prompt-injection reports
- suspicious redirects
- credential harvesting reports
- sensitive data request patterns
- checkout safety

### 6. API AegisID Reputation

Tracks tool and API safety.

Examples:

- supports Aegis verification
- honors collar restrictions
- creates receipts
- low incident rate
- stable response behavior
- clear scopes and permissions
- no known abuse patterns

### 7. Agent Platform Reputation

Tracks platform or runtime-level behavior.

Examples:

- how often agents from a platform exceed collars
- whether the platform supports Aegis controls
- whether agents from the platform respect tool boundaries
- incident frequency
- user revocation frequency

This should probably remain internal early on.

### 8. Developer Reputation

Long-term, agent developers may have reputations.

Examples:

- verified developer
- clean agent history
- low incident rate
- transparent permissions
- responsive to reports
- no malicious agent behavior

This becomes useful if Aegis later supports an agent marketplace or trust registry.

## Trust-Relevant Events

Aegis should track events that affect trust.

### Collar Events

Track:

- collar created
- collar updated
- collar attached
- collar revoked
- collar expired
- collar violated
- collar caused approval
- collar caused block

Do not track unrelated agent thoughts or pages just because a collar exists.

### Session Events

Track:

- protected session created
- session started
- session ended
- session expired
- session revoked
- session entered high-risk state
- session attempted sensitive action
- session completed cleanly

### Sensitive Action Events

Track when the agent requests or attempts:

- login
- payment
- purchase
- subscription
- public post
- comment
- direct message
- email send
- file upload
- form submission
- identity disclosure
- account setting change
- OAuth authorization
- legal, medical, financial, or education-related action

### Approval Events

Track:

- approval requested
- approval approved
- approval denied
- approval expired
- approval escalated
- approval overridden
- approval handled by guardian or trusted contact

### Runner Events

Track:

- Runner created
- Runner received task
- Runner completed task
- Runner failed task
- Runner terminated
- Runner used credential
- Runner disclosed claim
- Runner created receipt

Do not expose raw secrets in logs.

### Counterparty Events

Track:

- business verified
- website verified
- API verified
- domain mismatch
- unverified website requested sensitive data
- verified business honored policy
- business violated policy
- suspicious redirect detected
- prompt-injection report created

### Incident Events

Track:

- prompt injection detected
- credential harvesting attempt
- suspicious urgency
- sensitive data exfiltration attempt
- unauthorized action attempt
- repeated attempts after denial
- suspected scam
- user report
- business report
- dispute filed

### Outcome Events

Track:

- task completed successfully
- action completed successfully
- user marked outcome successful
- user reported issue
- business disputed action
- refund requested
- chargeback reported
- action reversed
- receipt challenged

## What Not To Track By Default

Aegis should avoid default collection of:

- every click
- every scroll
- every page visit
- full browsing history
- full page contents
- full LLM conversation
- full email contents
- full private messages
- raw passwords
- full credit card numbers
- raw identity documents
- unnecessary screenshots
- unrelated personal data

Riskier actions may justify more detailed receipts, but minimal logging should be the default.

Core line:

> Log more when risk is higher, not by default.

## Receipt-Based Reputation

Reputation should be built from receipts.

A receipt is a compact record of a trust-relevant event.

A receipt should answer:

- what action was requested
- which collar applied
- what decision was made
- who approved or denied
- what counterparty was involved
- whether the action succeeded
- whether any incident occurred

Example receipt:

{
  "id": "rec_123",
  "type": "sensitive_action",
  "user_aegis_id": "aid_user_123",
  "agent_session_id": "aid_session_456",
  "collar_id": "collar_789",
  "action_type": "purchase",
  "decision": "approved_by_user",
  "counterparty_type": "verified_business",
  "counterparty_id": "aid_business_123",
  "amount_bucket": "50_to_100",
  "sensitive_data_shared": false,
  "outcome": "completed",
  "incident": false,
  "created_at": "2026-04-26T22:14:00Z"
}

The receipt should avoid unnecessary private detail.

For example, it may store amount bucket instead of exact amount unless exact amount is needed for a dispute.

## Receipt Detail Levels

Aegis should support different receipt detail levels.

### Level 1: Minimal Receipt

Default for most events.

Stores:

- event type
- action category
- collar ID
- decision
- counterparty trust status
- timestamp
- outcome

### Level 2: Detailed Receipt

Used for higher-risk actions.

Stores:

- domain
- action summary
- approval record
- policy snapshot
- limited context
- selected screenshots if necessary

### Level 3: Forensic Receipt

Used for disputes, enterprise workflows, elder protection, or high-risk categories.

Stores:

- richer browser trace
- form field categories
- network metadata
- screenshots
- approval chain
- agent intent summary
- counterparty policy at time of action

Forensic receipts should not be the default.

## Positive Reputation Signals

Positive user-side signals may include:

- completed task within collar limits
- sensitive action approved properly
- no unnecessary sensitive data disclosure
- no disputes after action
- purchase completed with verified merchant
- travel booking completed without issue
- post or message approved before publishing
- identity claim disclosed minimally
- repeated clean behavior across verified counterparties
- user marked result successful
- business confirmed successful interaction

Positive business-side signals may include:

- domain verified
- legal business verified
- published agent policy
- low dispute rate
- no prompt-injection reports
- no unnecessary identity requests
- supports Aegis receipts
- honors collar restrictions
- responds to disputes

Positive website/API signals may include:

- verified endpoint
- clear scopes
- supports Aegis verification
- low incident rate
- no suspicious redirects
- no credential harvesting reports

## Negative Reputation Signals

Negative user-side or agent-side signals may include:

- repeated attempts to bypass collar
- repeated attempts after denial
- attempted payment without approval
- attempted identity disclosure to unverified site
- attempted upload of blocked documents
- suspicious session behavior
- user dispute
- business dispute
- revoked collar used again
- unsafe agent runtime behavior

Negative business-side signals may include:

- prompt injection reports
- hidden instructions targeting agents
- credential harvesting behavior
- unnecessary sensitive data requests
- domain/business mismatch
- high dispute rate
- suspicious redirects
- fake urgency patterns
- policy violation
- unresolved incidents

Important:

A blocked action is not automatically negative.

Sometimes a block means Aegis worked correctly.

A block becomes negative when it indicates suspicious intent, repeated bypass attempts, policy violation, or malicious counterparty behavior.

## Category-Specific Reputation

Reputation should be category-specific.

Potential categories:

- shopping
- travel
- email
- social posting
- messaging
- finance
- healthcare
- legal
- education
- identity disclosure
- file upload
- business interaction
- API/tool usage

Example:

A User AegisID may have:

- shopping: established clean
- travel: new
- social posting: limited
- finance: no history
- identity disclosure: strict, no incidents

A Business AegisID may have:

- browsing: trusted
- checkout: trusted
- identity upload: untrusted
- agent policy: published
- dispute handling: good

## Trust Labels

Aegis can show simplified trust labels instead of raw scores.

Example user-side labels:

- New
- Verified
- Clean History
- Established
- High Trust
- Restricted
- Under Review

Example business-side labels:

- Unverified
- Domain Verified
- Business Verified
- Agent Policy Published
- Agent-Safe
- High Trust Partner
- Incident Reported
- Restricted

Trust labels should be explainable.

Do not show labels without reasons.

## Score vs Claims

Avoid relying on one black-box number.

Prefer trust claims.

Bad:

- Aegis Score: 742

Better:

- verified human-backed
- clean shopping history
- 18 successful shopping interactions
- no payment disputes
- no sensitive data incidents
- purchases require approval
- verified business
- no recent prompt-injection reports

Aegis may internally compute risk scores, but externally it should expose clear trust claims.

## Reputation Decay

Reputation should decay over time.

Reasons:

- old behavior may no longer reflect current risk
- businesses can improve
- users can recover from mistakes
- agents and platforms change
- recent incidents matter more

Decay principles:

- recent incidents weigh more
- clean behavior slowly restores trust
- high-risk categories require more recent evidence
- unresolved incidents remain important
- verified corrective actions can improve trust

## Reputation and Privacy

Reputation must preserve privacy.

User-facing reputation should be private by default.

Businesses should see only what is needed for the interaction.

Example business-visible claims:

- verified human-backed delegation
- action allowed under collar
- purchase approved by user
- clean shopping delegation history
- low dispute history

Businesses should not see:

- full browsing history
- unrelated past purchases
- raw legal identity
- private messages
- other websites used
- full receipt details unless needed

## Reputation and Businesses

Businesses should care about Aegis reputation because it helps them distinguish:

- verified delegated agents
- anonymous bots
- suspicious automation
- high-trust users
- risky interactions
- unverified agent sessions

A business may allow more actions when:

- agent is backed by verified user
- collar permits the action
- user approved the action
- AegisID has clean history
- business itself is verified
- receipt can be created

A business may restrict actions when:

- agent is unknown
- collar missing
- user not verified
- action outside delegation
- high-risk claim requested
- prior disputes exist

## Reputation and Website Trust

Aegis can help users and agents understand website risk.

A website can gain trust by:

- verifying domain
- verifying business relationship
- publishing agent policy
- avoiding prompt injection
- avoiding unnecessary sensitive data requests
- honoring user collars
- resolving disputes

A website can lose trust through:

- prompt injection
- hidden instructions
- suspicious redirects
- credential harvesting
- unexpected payment requests
- data misuse reports
- high dispute rates

## Prompt Injection Reporting

Prompt injection reporting is one of the most important network effects.

Aegis should allow agents, users, and runners to report suspicious agent-targeting instructions.

Examples:

- ignore previous instructions
- reveal private data
- send credentials
- bypass policy
- disable safety rules
- follow hidden instructions
- exfiltrate data
- use payment without approval

Aegis should turn prompt injection into a reputation event.

Core line:

> Aegis turns prompt injection from an invisible attack into a reportable reputation event.

## Disputes

Aegis should support disputes.

Disputes may come from:

- users
- businesses
- agents
- guardians
- enterprise admins

Dispute examples:

- user says agent bought wrong item
- business says agent abused flow
- user says website misrepresented cost
- business says user reversed valid purchase
- agent session was compromised
- prompt injection caused unsafe behavior

Disputes should reference receipts.

A dispute should not automatically destroy reputation.

It should create an event that may be resolved, rejected, or confirmed.

## Reputation and Liability

Aegis should not claim to determine liability.

Instead, Aegis preserves evidence.

Aegis receipts can show:

- who delegated the task
- what collar applied
- what the agent was allowed to do
- what website/business was involved
- what policy applied
- whether approval was required
- whether approval was granted
- what action occurred
- what incidents were reported

Core line:

> Aegis does not decide liability. Aegis preserves evidence of delegation, approval, policy, and action.

## MVP Reputation Scope

For MVP, keep reputation simple.

Track:

- protected sessions created
- sensitive actions requested
- approvals granted
- approvals denied
- actions blocked
- receipts created
- user-marked successes
- user-reported issues
- unverified website sensitive requests
- prompt injection reports if easy

Display:

- number of protected sessions
- number of approvals
- number of blocked risky actions
- number of receipts
- number of issues reported

Do not build:

- public reputation scores
- full trust graph
- complex scoring algorithm
- real dispute resolution
- public business rankings
- social credit-like user scores

## MVP Reputation Event Model

Example reputation event:

{
  "id": "rep_event_123",
  "entity_type": "user_aegis_id",
  "entity_id": "aid_user_123",
  "event_type": "sensitive_action_approved",
  "category": "shopping",
  "session_id": "sess_456",
  "receipt_id": "rec_789",
  "weight": 1,
  "created_at": "2026-04-26T22:14:00Z"
}

Example business reputation event:

{
  "id": "rep_event_456",
  "entity_type": "website_aegis_id",
  "entity_id": "aid_site_123",
  "event_type": "unverified_site_requested_payment",
  "category": "shopping",
  "session_id": "sess_456",
  "severity": "medium",
  "created_at": "2026-04-26T22:15:00Z"
}

## Reputation Event Severity

Events can have severity.

### Info

Normal events.

Examples:

- session created
- receipt created
- collar attached

### Positive

Trust-building events.

Examples:

- successful approved action
- clean completed session
- dispute-free verified business interaction

### Warning

Potentially risky but not necessarily malicious.

Examples:

- unverified website requested email
- ambiguous action required approval
- agent attempted blocked action once

### Negative

Trust-reducing event.

Examples:

- repeated bypass attempts
- confirmed prompt injection
- user dispute confirmed
- business violated policy

### Critical

Severe event.

Examples:

- credential harvesting
- payment fraud
- identity exfiltration attempt
- malicious verified business behavior
- compromised agent session

## Reputation Display

The UI should be simple.

For users:

- Protected sessions completed
- Sensitive actions approved
- Risky actions blocked
- Issues reported
- Clean categories

Example:

Your agents completed 12 protected sessions this week.  
Aegis blocked 3 risky actions.  
No sensitive identity was shared without approval.

For businesses:

- verification status
- agent policy status
- dispute rate
- incident reports
- agent-safe status

For internal risk:

- risk state
- recent warnings
- repeated blocks
- suspicious patterns

## Avoiding Overcollection

Before logging any event, ask:

1. Does this event affect trust, safety, approval, accountability, or reputation?
2. Can we store less detail and still preserve the trust signal?
3. Does the user need to know this was recorded?
4. Could this data feel creepy if exposed?
5. Is this necessary for a receipt, dispute, or risk decision?

If not, do not store it.

## Future Reputation Features

Future versions may include:

- business trust profiles
- website trust badges
- public agent-safe labels
- prompt injection report network
- dispute resolution workflow
- reputation portability
- category-specific trust tiers
- verified developer reputation
- agent platform reputation
- elder protection trust signals
- family/guardian approval history
- enterprise trust dashboards
- insurance or guarantee partnerships

## Core Lines To Preserve

- Agents are disposable. Trust is not.
- Reputation should attach to durable AegisID, not disposable agent instances.
- Aegis reputation is not a score of who you are. It is a history of how safely your agents act under verified delegation.
- Track trust-relevant receipts, not everything.
- Log more when risk is higher, not by default.
- Aegis turns prompt injection from an invisible attack into a reportable reputation event.
- Aegis does not decide liability. Aegis preserves evidence of delegation, approval, policy, and action.
- Trust should be category-specific, explainable, and privacy-preserving.

