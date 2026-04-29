# TRUST_GRAPH.md

Long-term trust graph and reputation direction for Aegis.

---

## 1. Core Thesis

Aegis is not a browser wrapper. Aegis is not an agent builder. Aegis is not an analytics platform.

Collars, approvals, protected browsers, and runners are the wedge. The trust graph is the moat.

The Aegis Pass and AegisID are easy to copy architecturally. Any competitor can create an ID system. What is not easy to copy is the history of verified delegated actions, user approvals, runner completions, credential exposure incidents, disputes, and outcomes that accumulates inside the graph over time.

An AegisID alone is nothing. An AegisID with 200 runner-completed purchases, zero credential exposure incidents, a clean dispute record, and established trust claims in three action categories — that is something no competitor can replicate by copying the architecture.

Agents are disposable. AegisID reputation is durable.

When an agent session ends, the action history, trust claims, and receipts tied to the backing User AegisID persist. The next agent — a different LLM, a different platform — picks up the same reputation.

**Core lines:**
- Platform IDs prove origin. AegisID proves trust.
- Agents are disposable. Trust is not.
- Aegis reputation is a counterparty trust layer for agent-mediated action.
- The ID is not the moat. The trust graph is the moat.

---

## 2. What The Trust Graph Answers

The trust graph exists to answer trust questions at the moment of an agent-mediated action — not to generate dashboards, analytics, or consumer profiles.

### For websites, APIs, and businesses receiving an agent-backed action:

- Is this agent backed by a real, verified user?
- What is it authorized to do under its current collar/delegation?
- Has this AegisID completed this category of action safely before?
- Has it purchased before? Under approval constraints?
- Has it submitted sensitive forms before without incident?
- Has it used verified claims (student, employee, adult) before?
- Does it have unresolved disputes?
- Does it have credential exposure incidents?
- Is the current action within its established trust range?
- Should this action be allowed, restricted, require additional approval, or blocked?

### For agents and users interacting with a website, API, or business:

- Is this website verified? Is this business real?
- Does this website publish an agent-safe policy?
- Has this business accepted Aegis Runner actions before?
- Does it have prompt-injection incident reports?
- Does it request unnecessary sensitive fields from agents?
- Does it have unresolved agent disputes?
- Does it honor Aegis collars?
- Should the agent share information, proceed, request user approval, or block?

Both sides need reputation. An agent presenting a clean AegisID to a site with no agent policy and a history of prompt-injection reports is still exposed. A site with a published agent policy and verified runner-transaction history cannot trust a bare API call with no delegation context.

Aegis gives both sides what they need to make a trust decision.

---

## 3. Graph Entities

Each entity contributes reputation signal to the trust graph.

**User AegisID** — the durable identity of a human user. Anchors all agent delegation. Accumulates trust claims across sessions, agents, and platforms. This is the persistent identity that makes reputation portable even as agents change.

**Agent Session AegisID** — the ephemeral identity of a single agent session. Tied to the backing User AegisID and its active collar. Represents one delegation of authority. When the session closes, the session AegisID is retired. Its receipts remain under the User AegisID.

**Delegation / Collar** — the authorization document. Defines what the agent is allowed to do, what requires approval, and what is blocked. A delegation ties a User AegisID to a task scope. It is the verifiable proof that a specific agent was authorized for a specific purpose.

**Runner Task** — a record of a sensitive step executed by Aegis Runner on behalf of the user. Runner tasks are the strongest positive signal in the graph: they represent approved, Aegis-controlled execution where secrets were used but never exposed to the agent.

**Receipt** — the trust-relevant event record for a sensitive action. Receipts are graph edges (see section 6). They connect the user, the agent session, the collar, the website, the action category, the approval decision, and the outcome. Raw receipts are private; aggregated claims derived from receipts are shareable.

**Verified Claim** — a verifiable assertion about the user backed by a third party or by Aegis itself. Examples: human-backed, student status, employment status, adult-verified, domain owner. Claims can be disclosed without revealing the underlying document.

**Website AegisID** — the durable identity of a website or web application. Carries domain verification, published agent policy, agent transaction history, prompt-injection reports, and dispute history. Websites accumulate reputation as counterparties just as users do.

**Business AegisID** — the durable identity of a registered business entity. Carries business verification, dispute history, agent-safe behavior record, and accepted Aegis Runner transaction count.

**API AegisID** — the durable identity of a third-party API. Carries verified scope definitions, access history, incident reports, and agent policy.

**Incident Report** — a record of a negative or potentially harmful event: prompt injection, credential harvesting attempt, unauthorized action attempt, collar bypass attempt, suspicious redirect. Incidents are tracked with severity and status.

**Dispute Record** — a record of a dispute between any two parties (user, agent, website, business). Tracked with lifecycle status: open, under_review, resolved, dismissed, confirmed.

**Agent Platform Identity** — the identity of the LLM platform or agent framework executing the session (e.g., Claude, ChatGPT, a custom agent). A user's AegisID can accumulate history across multiple platforms. Platform identity is informational; it does not replace the User AegisID as the anchor.

**Developer Identity** — the identity of a developer building on Aegis APIs. Carries API usage history, abuse reports, and published application identity.

---

## 4. User/Agent-Side Reputation

User/agent-side reputation is the reputation that makes a website, API, or business more willing to trust an Aegis-backed agent action.

It is **not** a consumer analytics profile. It is **not** a social credit score. It is **not** a surveillance log.

It is a set of category-specific trust claims that allow a counterparty to make a trust decision about an incoming agent-backed action without requiring them to know who the user is, what they bought, or where they browsed.

**Trust claims on the user/agent side:**

- verified_human_backed
- verified_student_backed
- verified_employee_backed
- verified_adult
- clean_purchase_history
- runner_completed_purchases: N
- payment_dispute_rate: low / medium / high
- credential_exposure_incidents: 0 / N
- sensitive_form_completion_history: limited_clean / established_clean
- verified_claim_usage_history: N disclosures, no disputes
- low_collar_bypass_attempts
- low_unresolved_disputes
- actions_completed_under_approval_constraints: N
- email_or_messaging_history: limited / established
- file_upload_history: none / limited / established
- api_usage_history: read_only / read_write / established

**Reputation must be category-specific.** A single generic score is wrong for two reasons:

1. An AegisID may be established and clean in shopping but new and unverified in stock trading. A generic score would misrepresent the actual risk.
2. Counterparties need to know the trust level for the *specific category* of action being requested, not an average across all actions.

**Categories:**
- browsing / research
- shopping / purchases
- travel booking
- financial actions
- stock trading
- healthcare forms
- education / student verification
- employment verification
- identity disclosure
- social posting
- email / messaging
- file uploads
- API / tool usage

A counterparty receiving an agent action in the `shopping` category should see shopping-category trust claims only. They do not need to know whether the same AegisID has a healthcare history.

---

## 5. Website/Business-Side Reputation

Website/business-side reputation is the reputation that makes agents and users more willing to trust a site, business, or API as a counterparty for agent-mediated action.

A user delegating a task to an agent needs to know whether the destination can be trusted to receive that agent without prompt-injecting it, harvesting unnecessary data, or behaving outside normal business parameters.

**Trust claims on the website/business side:**

- domain_verified
- business_verified
- agent_policy_published
- agent_safe_checkout
- aegis_runner_purchases_completed: N
- agent_dispute_rate: low / medium / high
- prompt_injection_reports_recent: 0 / N
- credential_harvesting_reports: 0 / N
- unnecessary_sensitive_field_requests: none_detected / flagged
- honors_aegis_collars
- supports_receipts
- refund_and_cancellation_behavior: clear / disputed
- api_scopes_clear_and_enforced

A website with 500 Aegis Runner-completed purchases, zero prompt-injection reports, a low dispute rate, and a published agent policy is a fundamentally more trustworthy counterparty for agent-mediated purchases than an unknown site with no record.

---

## 6. Receipts As Graph Edges

Receipts are not logs. Receipts are graph edges.

A log records what happened. A graph edge connects two entities with context, direction, and outcome.

Every receipt connects:
- **User AegisID** — who delegated the action
- **Agent Session AegisID** — which agent session executed it
- **Collar / Delegation** — what authority was granted
- **Website / Business / API AegisID** — which counterparty received the action (if known)
- **Action category** — what kind of action it was
- **Approval decision** — allow / approval_required / block / completed_by_runner
- **Runner task** — whether Aegis Runner executed the sensitive step
- **Outcome** — completed / failed / disputed
- **Incident status** — none / reported / resolved

**Example receipt edge:**

> User AegisID `aid_user_123` delegated `purchase_under_100` to Agent Session `aid_session_456` via collar `col_abc`. Website `aid_site_789` (example-store.com) received the action in category `shopping`. User approval was required. Aegis Runner completed the step. No credentials were exposed to the agent. Outcome: completed. Dispute status: none.

This edge contributes to:
- The User AegisID's `runner_completed_purchases` count
- The User AegisID's `credential_exposure_incidents: 0` record
- The Website AegisID's `aegis_runner_purchases_completed` count
- The collar's `approval_required_actions` exercised record

Receipts accumulate into trust claims through aggregation. The raw receipt stays private. The derived claims are what counterparties see.

---

## 7. Trust Claims Instead Of Raw History

Aegis must not expose raw private history to counterparties.

**Bad:**
- showing all past purchases and amounts
- showing the exact sites visited in a session
- showing the contents of sensitive forms
- showing private documents submitted as verified claims
- exposing raw card numbers, addresses, or identity documents in any context

**Good:**
- `purchase_history: established_clean`
- `runner_completed_purchases: 14`
- `payment_dispute_rate: low`
- `credential_exposure_incidents: 0`
- `verified_student_claim: available`
- `sensitive_form_history: limited_clean`
- `raw_history_disclosed: false`

The counterparty gets enough signal to make a trust decision. They do not get a surveillance feed.

**Example: Agent/User Trust Passport**

```json
{
  "aegis_id": "aid_user_123",
  "agent_session_id": "aid_session_456",
  "delegation": {
    "task": "purchase running shoes under $100",
    "allowed_actions": ["browse", "compare", "purchase_with_user_approval"],
    "blocked_actions": ["subscription", "save_payment_method"]
  },
  "trust_claims": {
    "verified_human_backed": true,
    "purchase_history": "established_clean",
    "runner_completed_purchases": 14,
    "payment_dispute_rate": "low",
    "credential_exposure_incidents": 0,
    "sensitive_form_history": "limited_clean"
  },
  "privacy": {
    "raw_history_disclosed": false,
    "raw_payment_details_disclosed": false
  }
}
```

**Example: Website/Business Trust Passport**

```json
{
  "aegis_site_id": "aid_site_789",
  "domain": "example-store.com",
  "business_verified": true,
  "agent_policy_published": true,
  "trust_claims": {
    "aegis_runner_purchases_completed": 220,
    "prompt_injection_reports_recent": 0,
    "agent_dispute_rate": "low",
    "unnecessary_sensitive_field_requests": "none_detected"
  }
}
```

---

## 8. Action-Specific Trust

Trust must be action-specific. There is no general AegisID trust level.

An AegisID that is established and clean for shopping purchases is not automatically trusted for stock trades, healthcare form submission, or identity document upload. Each action category has independent history and independent trust claims.

**Examples:**

- An AegisID may be trusted for `shopping/purchases under $100` but not for `financial/stock_trading`.
- A website may be trusted for `browsing/research` but not for `identity_disclosure` if it has a history of unnecessary data requests.
- An API may be trusted for `read_access` but not for `write_access` if it has no write-scope history.
- A verified student claim may be safe to disclose as `verified_student: true` without uploading the full document.
- A travel booking agent may need separate approval constraints from a shopping agent even for the same user.

A counterparty receiving an action in category `financial/stock_trading` and seeing no established trust claims in that category should treat the action as high-risk regardless of the AegisID's shopping reputation.

Do not build a single generic reputation score. Category-specific trust is more accurate, more privacy-preserving, and harder to game.

---

## 9. Reputation Events

Reputation events are the raw inputs to the trust graph. They become reputation only after aggregation and context — a single event does not define reputation; patterns do.

| Event | Contributes to |
|---|---|
| `protected_session_created` | Session history for User AegisID |
| `sensitive_action_detected` | Collar activity for delegation record |
| `approval_requested` | Approval pattern for User AegisID |
| `approval_granted` | Trust signal: user is engaged and authorizing |
| `approval_denied` | Trust signal: user is actively reviewing |
| `runner_completed_action` | Strongest positive signal — sensitive step completed under control |
| `action_blocked_by_collar` | Positive signal: collar is functioning; agent is contained |
| `verified_claim_used` | Verified claim usage history |
| `sensitive_form_completed` | Sensitive form completion history |
| `purchase_completed` | Category-specific purchase history |
| `stock_trade_completed` | Category-specific financial history |
| `prompt_injection_reported` | Negative signal for Website AegisID |
| `credential_exposure_prevented` | Positive signal: Aegis enforcement worked |
| `credential_exposure_incident` | Serious negative signal for User or Website AegisID |
| `dispute_opened` | Negative signal; tracked with lifecycle |
| `dispute_resolved` | Outcome signal; context matters |
| `website_verified` | Positive signal for Website AegisID |
| `business_verified` | Positive signal for Business AegisID |
| `agent_policy_published` | Positive signal for Website AegisID |

No single event creates or destroys trust. Reputation emerges from the pattern.

---

## 10. Incidents And Disputes

The trust graph must include negative and corrective signals. A system that only records successes is not a trust system — it is a marketing dashboard.

**Incident types:**

- Prompt injection attempt on a website
- Credential harvesting attempt (site requesting unnecessary sensitive fields)
- Unauthorized action attempt by agent (trying to bypass collar)
- Repeated collar bypass attempts
- Suspicious redirect during agent session
- Unnecessary sensitive data request from website or API
- Agent attempting to extract vault values
- Failed Runner task with no clear cause

**Dispute types:**

- User disputes an agent-completed purchase
- Business disputes a receipt claim
- Agent disputes a block decision
- Payment dispute (charge without authorization)
- Identity claim dispute

**Dispute lifecycle:**

```
open → under_review → resolved
                    → dismissed
                    → confirmed
```

A dispute should not automatically destroy reputation. A single resolved dispute in 200 runner-completed transactions is different from a pattern of repeated disputes. The graph tracks status, not just presence.

A confirmed unresolved dispute against a Website AegisID is a strong signal to future agents interacting with that site. A confirmed unresolved dispute against a User AegisID is a signal to counterparties deciding whether to accept agent-backed actions from that user.

---

## 11. Privacy And Disclosure

The trust graph handles sensitive behavioral data. Privacy is a design constraint, not a feature.

**Principles:**

- **Disclose claims, not raw history.** Counterparties see `purchase_history: established_clean`, not a list of purchases.
- **Store receipts with minimal necessary detail.** Receipts record that a sensitive action occurred and its outcome — not the form values, card numbers, or identity documents involved.
- **Expose category-level trust when possible.** A site receiving a shopping action sees shopping trust claims only.
- **Use user consent for high-sensitivity disclosures.** Disclosing a verified healthcare claim or identity document requires explicit user action.
- **Keep consumer view separate from counterparty-visible view.** The user sees their full receipt history. Counterparties see derived claims only.
- **Allow revocation where possible.** Users should be able to revoke verified claims and limit claim disclosure.
- **Avoid social-credit framing in all external communication.** Aegis reputation is a counterparty trust tool for agent-mediated action. It is not a score, a rating, or a public profile.

Raw private history — purchase amounts, sites visited, form contents, identity documents — must never be exposed to any counterparty without explicit user consent. The graph derives trust claims from private history; it does not publish private history.

---

## 12. Early MVP Version (Reputation v0)

Reputation v0 is the minimum meaningful trust layer derivable from the current local demo with receipts and runner tasks.

It does not require a new backend system. It is a computed view over existing in-memory data.

**v0 includes:**

- Current receipts (raw, private to user)
- Runner task completions
- Approvals granted / denied
- Actions blocked by collar
- `sensitive_data_shared_with_agent: false` count (always false in current system)
- Mock vault uses (runner-fill count)
- Category counters: purchase / login / form / email / file
- Simple trust claims derived from those counters

**Example v0 trust claims object:**

```json
{
  "aegis_id": "aid_user_demo",
  "claims": {
    "runner_completed_purchases": 3,
    "credential_exposure_incidents": 0,
    "blocked_risky_actions": 2,
    "purchase_history": "demo_clean"
  }
}
```

This can be surfaced in the UI as a simple AegisID trust panel. It proves the concept without requiring a new data layer or external trust graph.

---

## 13. Website-Side MVP Version

The early website-side Aegis introduces the concept of a Website AegisID without requiring full business verification infrastructure.

**Features for website-side MVP:**

- **Website AegisID** — a unique ID for a domain/site, created when the domain is registered with Aegis
- **Domain verification mock** — verify ownership via DNS TXT record or `/.well-known/aegis-agent-policy.json`
- **Agent policy file** — `/.well-known/aegis-agent-policy.json` published by the site to declare what agents are allowed to do
- **Business profile page** — a public-facing page in the Aegis web UI showing the site's trust claims and policy

**Agent policy schema:**

```json
{
  "aegis_version": "0.1",
  "domain": "example-store.com",
  "agents_allowed": true,
  "allowed_actions": ["browse", "compare", "add_to_cart"],
  "approval_required_actions": ["purchase", "form_submit"],
  "blocked_actions": ["save_payment_method", "create_account"],
  "minimum_agent_trust_claims": {
    "verified_human_backed": true,
    "purchase_history": "any"
  }
}
```

- **Website trust page in the Aegis UI** — shows domain status, agent policy, runner transaction count, and incident reports
- **Prompt injection report button** — allows users or agents to report a suspected prompt-injection attempt tied to a Website AegisID
- **Simple domain trust API** — `GET /api/trust/site/:domain` returns trust claims for a Website AegisID

---

## 14. Why This Is The Moat

Any well-funded team can build collars, approvals, a protected browser runner, and an ID system. These are defensible for 6-18 months. They are not the long-term moat.

The trust graph is the moat because it requires time, real usage, and real counterparty adoption to build. It cannot be copied by reading the architecture.

**What competitors can copy quickly:**
- Collar definitions and policy engine
- Protected browser wrapper (Playwright/Puppeteer)
- Approval workflow
- ID generation and pass tokens
- A UI that looks similar

**What takes years to replicate:**
- Cross-platform verified delegation history accumulated across real user sessions
- Receipts from real agent-mediated actions with real counterparties
- Category-specific trust claims earned through real usage patterns
- Website and business reputation built through real agent transaction history
- Incident and dispute records that reflect real trust events
- Acceptance by counterparties — websites, APIs, and businesses that recognize and act on AegisID trust claims
- The network of users, agents, websites, and APIs that make the graph meaningful

The value of an AegisID is proportional to the density of the graph it is embedded in. An early AegisID with 1,000 clean runner-completed purchases, zero credential exposure incidents, and established trust in three action categories is worth more than any newly-created ID from a competitor — regardless of how good the competitor's technology is.

---

## 15. Risks

**Too early.** The agent ecosystem is young. Websites are not yet asking for agent trust signals. This risk is real; the strategy is to build the infrastructure before it is needed, not after.
*Mitigation: Start with internal trust claims for the user's own dashboard. Build toward counterparty-visible claims as the ecosystem matures.*

**Reputation feels creepy.** Users may be uncomfortable with a system that tracks their agent behavior.
*Mitigation: Frame as user-controlled, privacy-preserving, opt-in trust passport. Emphasize that raw history is private. Only claims are shared, and only with user consent.*

**Data privacy risk.** Aggregating behavioral data creates a high-value target.
*Mitigation: Store receipts with minimal detail. Derive claims from receipts and discard unnecessary raw data. Apply encryption at rest and access controls from day one of persistence.*

**False trust claims.** A bad actor could attempt to game the reputation system by manufacturing clean history.
*Mitigation: Weight trust claims by the quality of the events that produced them. Require real runner-completed actions, not just API calls. Introduce anomaly detection for trust farming patterns.*

**Gaming / fraud.** Coordinated trust farming, fake verified claims, or dispute manipulation.
*Mitigation: Rate-limit trust-building actions. Require human-backed verification for high-sensitivity claims. Treat verified claim abuse as a confirmed incident.*

**Businesses do not adopt.** If websites and APIs do not publish agent policies or recognize Website AegisIDs, the counterparty-side graph does not build.
*Mitigation: Make the agent policy file trivially easy to publish. Provide clear value proposition: sites with agent policies get better agent behavior and less friction.*

**Platform incumbents create closed IDs.** OpenAI, Google, or Microsoft could build their own closed agent identity system with more distribution.
*Mitigation: Open standards for agent policy files and trust claims. Interoperability where possible. Build network density before incumbents prioritize this space.*

**Legal / compliance risk.** Behavioral reputation data intersects with GDPR, CCPA, and emerging AI regulation.
*Mitigation: Design for data minimization from the start. Provide user data export and deletion. Avoid storing data that triggers regulated categories.*

**Overclaiming liability.** If Aegis trust claims are used by a counterparty to make a decision that causes harm, Aegis could face liability.
*Mitigation: Trust claims are informational signals, not guarantees. Make terms of use and signal limitations explicit in all counterparty-facing APIs.*

---

## 16. Roadmap

**Phase 1: Local receipt-based trust claims**
Derive simple trust claims from current in-memory receipts and runner tasks. Surface as a trust panel in the user UI. No new backend required.

**Phase 2: Persistent receipts and AegisID profile**
Move receipts and runner tasks to persistent storage (SQLite or Supabase). Build an AegisID profile page with trust claims derived from receipt history.

**Phase 3: Agent trust passport**
Generate a signed, shareable trust passport for agent sessions. Include delegation context, category-specific trust claims, and privacy flags. Make the passport available via API for counterparties.

**Phase 4: Website/Business AegisID**
Introduce Website AegisID with domain verification, agent policy file, and basic trust claims from runner transaction history. Build the website trust page in the UI.

**Phase 5: Website policy discovery**
Aegis automatically discovers `/.well-known/aegis-agent-policy.json` before agent sessions navigate to a site. Surface policy claims to the user and agent before the session begins.

**Phase 6: Incident and dispute system**
Build the full incident reporting and dispute lifecycle. Attach incidents and disputes to both User AegisIDs and Website AegisIDs. Include in trust claims and passport.

**Phase 7: Counterparty-visible trust claims**
Make category-specific trust claims available to counterparties via API under user consent. Build the consent flow for claim disclosure.

**Phase 8: Cross-platform trust graph**
Explore federation or open standards for AegisID trust claims across platforms. Allow other Aegis-compatible systems to contribute to or consume trust claims. Investigate selective disclosure proofs for high-sensitivity claims.

---

## 17. Core Lines To Preserve

These lines capture the product thesis and must not be contradicted by any implementation decision or external communication:

- Aegis gives agents usable identity, scoped authority, and portable reputation.
- Platform IDs prove origin. AegisID proves trust.
- Agents are disposable. Trust is not.
- The ID is not the moat. The trust graph is the moat.
- Reputation should be category-specific, explainable, and privacy-preserving.
- Websites trust agents because they are backed by AegisID.
- Agents trust websites because websites have Website AegisID.
- Receipts are graph edges, not just logs.
- Aegis reputation is a counterparty trust layer for agent-mediated action.
- Outside agents plan. Aegis executes sensitive steps.
- Agents can browse. Aegis decides when they can commit.
- Aegis is not consumer analytics. Aegis is not a social credit score.
