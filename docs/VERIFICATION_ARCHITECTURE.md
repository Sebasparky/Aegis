# Verification Architecture

Antigen Verification System v1 design direction.
Status: Architecture / Pre-implementation.

---

## Product Thesis

Agents acting on behalf of users often need to prove something about the user — that they are a student, a military member, a business owner, a domain controller, or just a verified human. Today agents have no way to carry this proof. They either skip the verification wall or ask the user to hand over documents and credentials directly.

Antigen's Verification pillar gives users a portable, signed, scoped identity layer. Users complete verification once with a trusted provider. Antigen stores the normalized claim, not the raw evidence. When an agent or website needs proof, the user approves a minimal disclosure. A signed receipt records what was shared, to whom, and when.

**The core principle:** Antigen orchestrates provider-backed verification. It does not build raw identity verification logic internally. The provider verifies the human. Antigen holds the signed result and controls disclosure.

Disclosure is tiered. Within an active delegation, websites and agents can ask whether an agent is backed by a verified user and receive a signed boolean trust signal — without seeing the user's underlying identity. Specific claim details (school name, military branch, business name, gov ID country, etc.) require a user disclosure policy or per-request approval.

---

## What Antigen Verifies

Antigen does not verify users directly. It connects users to trusted verification providers and issues signed claims based on provider results. Antigen's value is in the claim lifecycle — issuance, storage, scoped disclosure, expiry, and audit — not in document inspection or biometric matching.

Antigen verifies (through providers):

- **Email ownership** — user controls a specific email address
- **Phone ownership** — user controls a specific phone number
- **Government ID** — real-name identity confirmed against a government-issued document
- **Student status** — enrolled student at an accredited institution
- **Military / veteran status** — active-duty, reserve, or veteran status
- **Business / organization control** — authorized representative of a registered entity
- **Domain ownership** — control of a registered DNS domain
- **Employment / professional status** — current employment at a named organization (future)

---

## What Antigen Does Not Do

- Antigen does not store raw government ID images, passport scans, SSNs, biometrics, or facial photos.
- Antigen does not build a KYC pipeline internally — it delegates document inspection to the provider.
- Antigen does not let agents request arbitrary identity details — agents request claim types, not documents.
- Antigen does not auto-disclose specific claim details without a user disclosure policy or per-request approval. Low-detail trust signals (`verified_human_backed`, `email_verified`, etc.) may be disclosed automatically within an active delegation context — they are boolean flags, not personal data.
- Antigen does not replace legal identity proofing — it orchestrates it and records the result.
- Antigen does not allow providers to pull user data after the verification session completes.
- Antigen does not store full provider response payloads — only normalized claims and provider references.

A future **Sensitive Evidence Vault** may support encrypted raw document custody (with user consent) for use cases like secure document handoff. That is explicitly post-launch and out of scope for Verification v1.

---

## Provider-Backed Verification Model

Verification follows a three-party model:

```
User  ──► Provider Session ──► Provider Result
                                     │
                             Antigen normalizes
                                     │
                          VerifiedClaim + VerificationCard
                                     │
                         Signed, stored, user-controlled
                                     │
                   Agent or Website requests disclosure
                                     │
                           User approves (Antigen UI)
                                     │
                       Minimal claim returned + DisclosureReceipt
```

**Antigen's role in this chain:**

1. Presents verification options to the user.
2. Initiates a `VerificationProviderSession` — a structured handoff to the provider (redirect, OAuth, iframe, or Antigen-managed flow depending on provider type).
3. Receives the provider result (webhook callback, polling, or post-redirect result).
4. Normalizes the result into `VerifiedClaim` objects — boolean or tiered, never raw.
5. Packages claims into a signed `VerificationCard`.
6. Stores the card and claim metadata. Raw evidence stays with the provider.
7. Manages card expiry, revocation, and re-verification.

**Provider session model:**

- Sessions are ephemeral — created to initiate verification, not stored permanently.
- The session holds: `provider_name`, `provider_session_id` (their reference), `verification_type`, `status`, `created_at`, `expires_at`.
- After completion, only the provider reference ID is retained in the card — not the session state or raw response.

---

## Verification Types

### email_ownership

Proves the user controls a specific email address. Uses a link-click or code challenge.

- Assurance level: `provider_verified`
- Claim fields: `email_domain`, `verified_at`
- Provider: `email_otp` (real Resend delivery via `verify.antigenlabs.ai`). `local_email` is the dev console fallback. `mock_email` uses the existing challenge relay for local testing without sending any email.
- Expiry: 1 year
- Feeds: `DelegationPassport.human_subject.identity_level: "email_verified"`

### phone_ownership

Proves control of a phone number via SMS or voice code.

- Assurance level: `provider_verified`
- Claim fields: `phone_country_code`, `verified_at`
- Provider: Twilio Verify, Vonage, or equivalent
- Expiry: 1 year

### government_id

Real-name identity confirmed against a government-issued document (driver's license, passport, national ID).

- Assurance level: `document_verified`
- Claim fields: `country_of_issue`, `document_type`, `verified_at`, `name_verified: boolean`, `age_verified: boolean`, `address_verified: boolean`
- Provider: Stripe Identity, Persona, Jumio, Onfido, or equivalent
- Raw document: stays with provider. Antigen never stores the image or document number.
- Expiry: 2 years or until provider expires the session
- Feeds: `DelegationPassport.human_subject.identity_level: "government_id_verified"`

### student_status

Active enrollment at an accredited college or university.

- Assurance level: `provider_verified`
- Claim fields: `institution_name`, `institution_country`, `enrollment_status: "enrolled" | "graduated"`, `verified_at`
- Provider: SheerID, Student Beans, or `.edu` email flow
- Expiry: 1 academic year

### military_veteran_status

Active duty, reserve, or veteran status.

- Assurance level: `provider_verified`
- Claim fields: `branch`, `status: "active" | "reserve" | "veteran"`, `country`, `verified_at`
- Provider: SheerID, ID.me, or equivalent
- Expiry: 2 years for veteran; 1 year for active/reserve (re-verification recommended)

### business_org_control

Authorized representative of a registered business entity.

- Assurance level: `provider_verified`
- Claim fields: `business_name`, `business_country`, `registration_number_present: boolean`, `role: "owner" | "director" | "authorized_agent"`, `verified_at`
- Provider: Stripe Identity, Middesk, or equivalent
- Expiry: 2 years

### domain_ownership

Control of a registered DNS domain.

- Assurance level: `provider_verified`
- Claim fields: `domain`, `verification_method: "dns_txt" | "html_file" | "meta_tag"`, `verified_at`
- Provider: Antigen-managed (DNS/HTTP verification, no third party required)
- Expiry: 1 year

### employment_status (future)

Current employment at a named organization.

- Assurance level: `provider_verified`
- Provider: Argyle, The Work Number, or equivalent
- Out of scope for v1

---

## Data Model

### VerificationProviderSession

Ephemeral. Exists only during the active verification flow. Deleted after result is received.

```typescript
interface VerificationProviderSession {
  session_id: string;                           // vcpsess_...
  user_id: string;
  verification_type: VerificationType;
  provider_name: string;
  provider_session_id?: string;                 // provider's reference
  status: "initiated" | "in_progress" | "completed" | "failed" | "expired" | "cancelled";
  redirect_url?: string;                        // provider redirect if applicable
  return_url: string;                           // where to land after provider flow
  created_at: string;
  expires_at: string;
  completed_at?: string;
  error?: string;
}
```

Not stored long-term. Only `provider_session_id` is carried forward into the card.

---

### VerifiedClaim

A single normalized, typed claim. Multiple claims can exist per card (e.g., name verified + age verified from one gov ID session).

```typescript
interface VerifiedClaim {
  claim_id: string;                             // vclaim_...
  card_id: string;                              // parent card
  claim_type: VerificationType;
  claim_value: VerifiedClaimValue;              // see below — normalized, never raw
  assurance_level: AssuranceLevel;
  provider_name: string;
  provider_reference_id?: string;              // opaque provider reference, not a raw doc ID
  verified_at: string;
  expires_at?: string;
  revocation_status: "valid" | "revoked" | "provider_revoked";
}

type AssuranceLevel = "self_asserted" | "provider_verified" | "document_verified";
```

**VerifiedClaimValue** — normalized, never raw document content:

```typescript
type VerifiedClaimValue =
  | { kind: "email_ownership";      email_domain: string; }
  | { kind: "phone_ownership";      phone_country_code: string; }
  | { kind: "government_id";        country_of_issue: string; document_type: string; name_verified: boolean; age_verified: boolean; address_verified: boolean; }
  | { kind: "student_status";       institution_name: string; institution_country: string; enrollment_status: "enrolled" | "graduated"; }
  | { kind: "military_status";      branch?: string; status: "active" | "reserve" | "veteran"; country: string; }
  | { kind: "business_control";     business_name: string; business_country: string; registration_number_present: boolean; role: string; }
  | { kind: "domain_ownership";     domain: string; verification_method: string; }
```

No document numbers, SSNs, full names, addresses, or birthdates in claim values.

---

### VerificationCard

The signed, portable claim bundle. One card per verification session. Multiple claims per card are allowed.

```typescript
interface VerificationCard {
  card_id: string;                              // vc_...
  schema_version: "1.0";
  issuer: "antigen";
  user_id: string;
  user_aegis_id: string;
  claims: VerifiedClaim[];
  primary_claim_type: VerificationType;
  provider_name: string;
  assurance_level: AssuranceLevel;
  issued_at: string;
  expires_at: string;
  revocation_status: "valid" | "revoked" | "expired";
  revoked_at?: string;
  revocation_reason?: string;
  disclosure_policy: DisclosurePolicy;
  limitations: {
    not_a_guarantee: true;
    provider_result_only: true;
    raw_document_revealed_to_agent: false;
    raw_document_revealed_to_website: false;
    out_of_scope_identity_details_not_covered: true;
  };
  verification: {
    card_hash: string;                          // SHA-256 of canonical card (excluding verification block)
    card_jws: string;                           // EdDSA JWS over card_hash
    jws_present: boolean;
    signing_alg: "EdDSA";
    signed_at: string;
  };
}

type DisclosurePolicy =
  | "user_approval_required"                   // default — Tier 1 trust signals auto; Tier 2 details need per-request approval
  | "agent_visible"                            // Tier 1 + Tier 2 for user's own agents, no per-request prompt
  | "website_allowed"                          // Tier 1 + Tier 2 for compatible websites, no per-request prompt
  | "restricted";                              // Tier 1 suppressed + Tier 2 blocked; card fully locked
```

**Signing follows the exact same pattern as `DelegationPassport` and `UserApprovalReceipt`:**
- Hash all immutable fields (exclude `verification` block and `revocation_status`)
- Sign the hash with EdDSA via `jose`
- Use `AEGIS_RECEIPT_JWS_PRIVATE_JWK`
- `jws_present: false` in dev mode without the key — non-blocking

---

### DisclosureReceipt

Immutable audit record of a claim disclosure event. Created whenever a claim is shared with an agent or website.

```typescript
interface DisclosureReceipt {
  receipt_id: string;                           // vcdiscl_...
  receipt_type: "claim_disclosure";
  schema_version: "1.0";
  issuer: "antigen";
  user_id: string;
  user_aegis_id: string;
  card_id: string;
  claim_types_disclosed: VerificationType[];   // only the specific claim types shared
  disclosure_target: {
    target_type: "agent" | "website";
    agent_id?: string;
    delegation_id?: string;
    domain?: string;
    purpose: string;                            // human-readable purpose from requester
  };
  approval_method: "user_click";
  approved_at: string;
  uar_id: string;                               // linked UserApprovalReceipt
  limitations: {
    raw_document_revealed_to_target: false;
    raw_document_in_receipt: false;
    full_card_revealed: false;
  };
  verification: {
    receipt_hash: string;
    receipt_jws: string;
    jws_present: boolean;
    signing_alg: "EdDSA";
    signed_at: string;
  };
}
```

---

## Verification Cards / Signed Claim Bundles

A VerificationCard is the portable proof object. It is analogous to a signed verifiable credential, but scoped to Antigen's trust model and disclosure flow.

**Key properties:**

- **Signed** — EdDSA JWS over the canonical card hash, using the same key as all other Antigen signed documents.
- **Immutable core** — the hash covers all content except `revocation_status`, which is mutable and excluded.
- **Provider-anchored** — each card references a `provider_name` and `provider_reference_id` so the underlying verification can be traced back to its source.
- **Claim-minimal** — claims contain only the normalized assertion (boolean or tier), not raw document content.
- **Expiring** — cards carry `expires_at`. Expired cards are not automatically removed but their disclosures should note expiry.
- **Revocable** — `revocation_status` is mutable. Revoked cards cannot be disclosed. `revoked_at` + `revocation_reason` record why.

**How cards relate to existing primitives:**

- A completed government ID card updates `DelegationPassport.human_subject.identity_level` to `"government_id_verified"` at next passport refresh.
- A completed email card updates identity_level to `"email_verified"`.
- Completed cards set `AegisIDTrustClaims.verified_human_backed: true`.
- Cards are referenced in `DelegationTrustProfile` capability summaries under `identity_profile_available`.

---

## Scoped Disclosure to Agents and Websites

Disclosure is strictly tiered. There is no public query surface — every request must come from an active delegation context.

---

### Tier 1 — Trust Signals (automatic in active delegation context)

Trust signals answer exactly three questions:
1. Is this agent backed by a verified user?
2. Does a valid claim of this type exist?
3. What is the assurance level and expiry?

Trust signals are boolean or availability flags. They are not personal data. They contain no school name, institution, legal name, DOB, address, gov ID country, document type, military branch or status, business name, email domain, or provider reference.

**Trust signal request flow:**

```
1. Agent or website (within active delegation) requests:
   GET /api/agent/v1/trust-signals?claim_type=student_status
   Authorization: Bearer <delegation-token>

2. Antigen checks:
   - Is the token valid and delegation active?
   - Does the delegating user have a valid, non-revoked card matching claim_type?
   - Is disclosure_policy != "restricted"?

3. Returns signed trust signal (no approval required):
   {
     "claim_type": "student_status",
     "signal": "student_status_available",
     "available": true,
     "assurance_level": "provider_verified",
     "expires_at": "2027-05-20T10:00:00Z",
     "raw_document_revealed_to_agent": false,
     "signal_jws": "..."
   }

4. A TrustSignalDisclosureRecord is logged (not signed — not a receipt-grade event).
```

**What trust signals never contain:**

- `institution_name` or `enrollment_status`
- `country_of_issue` or `document_type`
- `branch` or military `status`
- `business_name` or `business_country`
- `email_domain`
- `provider_name` or `provider_reference_id`
- Any raw document field

**When trust signals are suppressed:**

- Card `disclosure_policy` is `"restricted"` — Antigen returns `available: false` (card locked)
- No valid, non-revoked card exists for the claim type — Antigen returns `available: false`

---

### Tier 2 — Scoped Claim Details (policy or per-request approval)

Claim detail responses include specific field values that reveal personal information. These require either a pre-set user disclosure policy or an explicit per-request user approval.

**Required condition (one of):**
- Card `disclosure_policy` is `"agent_visible"` (user's own agent, no per-request prompt)
- Card `disclosure_policy` is `"website_allowed"` (compatible website, no per-request prompt)
- Explicit user approval via the approval inbox (any `disclosure_policy`)

**Claim detail request flow:**

```
1. Agent calls request_verified_claim(
     claim_type: "student_status",
     purpose: "verify student discount eligibility",
     delegation_id: "delg_...",
   )

2. Antigen checks:
   - Does the user have a valid, non-revoked card with a matching claim?
   - Is disclosure_policy == "agent_visible" or "website_allowed"? → auto-disclose with receipt
   - Otherwise: requires user approval

3. If approval required:
   - Antigen creates a pending ApprovalRequest (same approval inbox as route runs)
   - Approval card shows: claim type, requesting agent, purpose, what will be shared
   - User approves or denies

4. On approval:
   - UserApprovalReceipt is created (signed)
   - Minimal claim value is returned (not the full card, not raw doc)
   - DisclosureReceipt is created (signed, links UAR)

5. On denial:
   - UserApprovalReceipt is created with decision: "denied"
   - Agent receives CLAIM_DISCLOSURE_DENIED
```

**What the agent receives** (example for `student_status`):

```json
{
  "claim_type": "student_status",
  "assurance_level": "provider_verified",
  "claim_value": {
    "kind": "student_status",
    "institution_name": "University of Michigan",
    "institution_country": "US",
    "enrollment_status": "enrolled"
  },
  "verified_at": "2026-05-20T10:00:00Z",
  "expires_at": "2027-05-20T10:00:00Z",
  "disclosure_receipt_id": "vcdiscl_...",
  "card_id": "vc_...",
  "raw_document_revealed_to_agent": false
}
```

The agent does not receive: `card_jws`, `card_hash`, `provider_reference_id`, other claims on the card, or any raw document data.

---

### Tier 3 — Forbidden (never disclosed to any external party)

- Raw government ID images, passport scans, facial photos
- SSNs, national ID numbers, document numbers
- Biometric data of any kind
- Full legal name, date of birth, home address
- Military branch or status tier
- Business registration number or legal entity details
- `provider_reference_id` or any provider internal reference
- Full provider response payloads
- Encrypted blobs, KMS material, private key material
- Any field that enables re-identification when combined with other fields

Tier 3 data never enters any Antigen API response, MCP tool response, receipt, or log line.

---

## Approval and Receipt Model

### Approval flow

Verification-related approvals use the same approval inbox as route run approvals (`/route-run-approvals`). No new approval infrastructure is needed.

Three new `approval_source` values:
- `verification_start` — user is asked to authorize initiating a verification session with a provider
- `claim_disclosure` — user is asked to approve sharing a specific claim with an agent or website
- `verification_re_verify` — user is asked to re-verify an expired or revoked card

### Receipt chain by disclosure tier

**Tier 1 — Trust signal auto-disclosure** does not produce a signed receipt. A lightweight `TrustSignalDisclosureRecord` is logged (in-memory, non-signed) for operational visibility. It captures: delegation_id, claim_type, signal_value, agent_id, timestamp. It is not a liability-grade record.

**Tier 2 — Scoped claim disclosure** produces the full signed receipt chain:

```
VerificationProviderSession (ephemeral, not a receipt)
    │
    ▼
VerificationCard (signed vc_... — issued once, updated only on revocation)
    │
    ▼ (on each Tier 2 disclosure)
UserApprovalReceipt (signed uar_... — user click to approve disclosure)
    │
    ▼
DisclosureReceipt (signed vcdiscl_... — links back to UAR and card)
```

The `DisclosureReceipt` is the audit-grade record of what was shared. It references:
- The card (`card_id`)
- The approval (`uar_id`)
- The specific claim types disclosed (not the full card)
- The disclosure target (agent or domain)
- Privacy literals (`raw_document_revealed_to_target: false`, etc.)

**Tier 3 — Forbidden disclosures** produce no record because they never happen.

---

## API Direction

All routes under `/api/verifications/`. No external agent self-approval.

### Verification management (user-facing)

```
GET    /api/verifications/types
       → list supported verification types with provider info and status

POST   /api/verifications/sessions
       → start a verification provider session
       body: { verification_type, provider_name? }
       → { session_id, redirect_url?, status, expires_at }

GET    /api/verifications/sessions/:sessionId
       → check session status (used by return-URL polling)

POST   /api/verifications/sessions/:sessionId/complete
       → internal callback from provider (or manual complete for dev mock)
       → normalizes result into VerifiedClaim + VerificationCard

GET    /api/verifications/cards
       → list user's verification cards (claims summary, no raw values)

GET    /api/verifications/cards/:cardId
       → detail: claim types, assurance level, expiry, disclosure_policy

GET    /api/verifications/cards/:cardId/verify
       → verify card hash + JWS integrity
       → { valid, hash_valid, signature_valid, expired, revoked }

PATCH  /api/verifications/cards/:cardId/disclosure-policy
       → update disclosure_policy (user preference)
       body: { disclosure_policy: "user_approval_required" | "agent_visible" | "restricted" }

POST   /api/verifications/cards/:cardId/revoke
       → user-initiated revocation
       body: { reason? }
```

### Disclosure (agent-facing via external API)

```
GET    /api/agent/v1/trust-signals
       → Tier 1: query trust signals for the delegating user (no personal detail)
       query: ?claim_type=student_status (optional; omit for all available signals)
       requires: valid delegation bearer token
       → [{ signal, available, assurance_level, expires_at, signal_jws,
             raw_document_revealed_to_agent: false }]

POST   /api/agent/v1/claim-disclosures
       → Tier 2: agent requests specific claim field values
       body: { claim_type, purpose }
       → { decision: "approved" | "pending_approval" | "no_matching_claim" | "denied" }
          if approved: { claim_value, disclosure_receipt_id, raw_document_revealed_to_agent: false }
          if pending_approval: { approval_request_id }

GET    /api/agent/v1/claim-disclosures/:disclosureId
       → poll Tier 2 disclosure status

GET    /api/internal/disclosure-receipts
       → admin/owner view of all Tier 2 disclosure audit records
```

---

## UI Direction

### /verify page

User's verification dashboard. Entry point for starting and managing verifications.

Sections:
- **Identity verified** — cards the user has completed (status chip: valid / expired / revoked)
- **Available verifications** — list of supported types with provider name, time estimate, and "Verify" CTA
- **Start verification** — launches the provider flow (redirect, modal, or inline)
- **Pending sessions** — sessions in progress with status and timeout countdown

Each card in the "Identity verified" list shows:
- Verification type (student, email, gov ID, etc.)
- Provider name
- Assurance level badge
- Expiry date
- Disclosure policy toggle (require approval / pre-approved for agents / locked)
- Revoke button

### /verification-cards page (detail)

Per-card view accessible from /verify. Shows:
- All claims on the card
- Disclosure history (DisclosureReceipts) — when shared, with whom, what claim
- JWS verification result (hash valid / signature valid / active)
- Re-verify button if expired

### Nav item

Add "Identity" to the sidebar nav in `apps/web/src/components/shell.tsx`, pointing to `/verify`.

---

## Security and Privacy Rules

### Hard rules — never violate

- **Raw evidence stays with the provider.** Antigen never stores government ID images, passport scans, SSNs, biometric data, facial photos, or full credit files. Provider stores the evidence; Antigen stores the normalized result.
- **`raw_document_revealed_to_agent: false`** — TypeScript literal false on all DisclosureReceipt objects, all agent API responses, and all MCP tool responses that reference a verification claim. Never set through a variable.
- **Agents receive claim types, not documents.** Agents request `claim_type: "student_status"`, not "send me the user's student ID image."
- **Auto-disclosure is limited to trust signals only.** Trust signals are boolean or availability flags — they contain no personal details, no provider references, no claim field values. See Tier 1 in the Scoped Disclosure section.
- **Trust signals are not public.** A trust signal requires a valid delegation token. There is no public query surface for any user's verification status.
- **Claim detail disclosure requires policy or approval.** Default disclosure policy is `user_approval_required`. Tier 2 claim details require the card's `disclosure_policy` to be `agent_visible` or `website_allowed`, or an explicit per-request user approval. Even `agent_visible` requires the user to have previously opted in.
- **Claim minimization.** Disclose only the specific claim type the agent or website requested. If a card has both `student_status` and `email_ownership` claims, a request for `student_status` does not expose `email_ownership`.
- **No cross-agent disclosure.** A DisclosureReceipt is scoped to the specific `delegation_id` or `domain` that requested it. Agents cannot request disclosures on behalf of other agents.
- **Verification sessions are short-lived.** `VerificationProviderSession` expires in 30 minutes. Stale sessions are cleaned up lazily.
- **Provider reference is opaque.** `provider_reference_id` is stored as an opaque string (not a URL to raw data). It must never be returned to agents — internal use only for provider support queries.
- **No re-identification.** Claim values must be designed so that a combination of claim values does not enable re-identification of the user's full legal identity from the API response alone. Trust signals (boolean-only) are safe by construction.

### Retention limits

- `VerificationProviderSession` — deleted after completion or expiry (ephemeral).
- `VerificationCard` — retained until user revokes or until 2 years after expiry (configurable in production).
- `DisclosureReceipt` — retained as an immutable audit record (no automatic deletion in v1).
- Raw provider webhooks / callbacks — not persisted; result is normalized immediately on receipt.

### Provider callback security

- Provider callbacks (webhooks) must use a shared secret or signature verification.
- Provider session IDs must be validated against the stored `VerificationProviderSession` — cannot be spoofed in the return URL.
- In v1 (dev mock mode), the `POST /api/verifications/sessions/:sessionId/complete` endpoint is internal only — not exposed as a public webhook target.

---

## Launch Policy: Disclosure Tiers

Default behaviors for all verification cards at launch:

| Disclosure policy | Tier 1 trust signals | Tier 2 claim details |
|---|---|---|
| `user_approval_required` (default) | Auto in active delegation context | Per-request user approval required |
| `agent_visible` | Auto | Auto for user's own agents (no prompt) |
| `website_allowed` | Auto | Auto for compatible websites (no prompt) |
| `restricted` | Suppressed — card locked | Blocked |

**Rules:**
- All new cards default to `user_approval_required`. Users must explicitly opt into `agent_visible` or `website_allowed`.
- Trust signals (Tier 1) are always available in active delegation contexts unless the card is `restricted`.
- `restricted` suppresses even trust signals — the card is completely locked. No signal, no detail.
- `agent_visible` and `website_allowed` are opt-in per card, not per claim. A user can set a student card to `agent_visible` while keeping a gov ID card at `user_approval_required`.
- A trust signal returning `available: false` does not reveal whether the claim does not exist or whether the card is restricted — both return the same response.

---

## Provider Integration Strategy

The architecture is provider-agnostic by design: a thin `VerificationProvider` interface abstracts the handoff.

**Provider abstraction pattern (v1 internal interface):**

```typescript
interface VerificationProvider {
  name: string;
  supported_types: VerificationType[];
  initiate(session: VerificationProviderSession): Promise<{ redirect_url?: string; provider_session_id: string }>;
  poll(provider_session_id: string): Promise<ProviderResult>;
  normalize(result: ProviderResult): VerifiedClaim[];
}
```

**Email providers (v1 — implemented):**

- `email_otp` — real OTP email delivery through Resend. **This is the preferred real email provider used by `/verify`.**
- `local_email` — dev console OTP fallback; prints the OTP to the server console. Used when `EMAIL_DELIVERY_PROVIDER` is not configured.
- `mock_email` — test/mock provider; returns a card immediately without sending any email. Uses the existing challenge relay for local testing.

**Delivery (email_otp):**

- Enabled when `EMAIL_DELIVERY_PROVIDER=resend` and `RESEND_API_KEY` are configured.
- Verified sending domain: `verify.antigenlabs.ai`
- Sender: `Antigen <noreply@verify.antigenlabs.ai>`
- Configurable via `EMAIL_FROM` env var.
- Falls back to `local_email` console mode when Resend is not configured.

**Privacy invariants for email verification:**

- Full email address is used only for delivery during the active verification session. It is never stored on `VerificationCard`.
- `VerificationCard.claim_value` for `email_ownership` stores `email_domain` only — never the full email address.
- Raw OTP is never persisted. Only a SHA-256 hash is stored temporarily in the session for code validation.
- OTP is never returned in any API response.
- After verification completes, neither the full email nor the OTP hash is retained.

**Abuse controls:**

- In-memory rate limiting: 3 sends per 15-minute window per user.
- 60-second resend cooldown.
- 5 failed code attempts per session — session invalidated on limit.

**Non-goals for email_otp v1:**

- Google OAuth is not implemented.
- Inbound email receiving is not needed for OTP verification.
- Resend receiving/webhooks are not part of v1.

Do not rebuild `email_otp` or `local_email` unless explicitly requested.

**Mock providers for other claim types (v1):**

- `MockStudentProvider` — returns a hardcoded student claim for a configurable test email domain.
- `MockGovIdProvider` — returns a normalized gov ID claim; never stores any document.

**v2 provider integrations to consider:**

| Category | Candidate providers |
|---|---|
| ID / document verification | Stripe Identity, Persona, Onfido, Jumio |
| Phone | Twilio Verify, Vonage Verify |
| Student / military | SheerID, ID.me, Student Beans |
| Business | Middesk, Stripe (business), Companies House (UK) |
| Domain | Antigen-managed (DNS TXT / HTTP challenge) |

Non-email provider integrations are post-v1 implementation scope.

---

## Roadmap Increments

### Increment 1 — Types and data model

- Add `VerificationProviderSession`, `VerifiedClaim`, `VerificationCard`, `DisclosureReceipt` to `packages/types/src/index.ts`
- Add `VerificationType`, `AssuranceLevel`, `VerifiedClaimValue`, `DisclosurePolicy` union types
- Add `verificationCards: Map<string, VerificationCard>` and `disclosureReceipts: Map<string, DisclosureReceipt>` to `apps/api/src/store/index.ts`
- Add signing helpers to `apps/api/src/lib/verificationCardSigning.ts` (mirror `delegationPassportSigning.ts` pattern)
- No API routes yet

### Increment 2 — Mock provider + card issuance

- Add `VerificationProvider` interface and three mock providers (email, student, gov ID)
- Add verification session routes (`POST /api/verifications/sessions`, `GET .../:sessionId`, `POST .../:sessionId/complete`)
- Complete session → normalize claims → issue signed VerificationCard
- No UI yet; test via curl / REST client

### Increment 3 — Verification UI

- Add `/verify` page: list cards, start verification, session status
- Add `/verification-cards/:cardId` page: claim detail, disclosure history, JWS verify
- Add "Identity" nav item to shell
- Connect to card issuance routes from Increment 2

### Increment 4 — Scoped disclosure and receipts

- Add disclosure request route (`POST /api/agent/v1/claim-disclosures`)
- Wire into existing approval inbox: disclosure requests appear in `/route-run-approvals`
- On approval: create `UserApprovalReceipt` + `DisclosureReceipt` (signed)
- Return minimal claim value to agent (not full card)
- Add `PATCH /api/verifications/cards/:cardId/disclosure-policy` and disclosure history to `/verification-cards`

### Increment 5 — Passport integration

- On card issuance (email or gov ID), refresh the user's active delegation passport if one exists, updating `human_subject.identity_level`
- Populate `identity_profile_available: true` in `DelegationTrustProfile` capability summaries when a valid card exists
- Add `AegisIDTrustClaims.verified_human_backed: true` when a `provider_verified` or `document_verified` card exists

---

## Launch Policy: Claims First, Raw Evidence Later

This section is the authoritative policy statement for Verification v1 launch. Any design that contradicts it requires explicit approval before proceeding.

### What is in scope for v1

- Signed, normalized `VerificationCard` objects containing `VerifiedClaim` values
- Provider references (opaque IDs pointing back to the issuing session at the provider)
- Attestation metadata: claim type, assurance level, provider name, issued_at, expires_at
- `DisclosureReceipt` — signed audit of what claim was shared, with whom, when
- Scoped agent-facing API returning minimal claim values (no full card, no raw data)

### What is out of scope for v1

**Antigen v1 does not store:**

- Government-issued ID images (driver's license, passport, national ID)
- Passport or visa scans
- Student ID card images or numbers
- Military ID or DD-214 scans
- Social Security Numbers (SSN), Tax Identification Numbers (TIN), or national ID numbers
- Biometric data (facial photos, fingerprints, voice prints, liveness scan outputs)
- Raw provider response payloads (webhook bodies, API responses from Stripe Identity, Persona, Onfido, etc.)
- Full legal names, dates of birth, physical addresses, or financial account details
- Any document number, issuer serial number, or credential number from an identity document

**The rule:** If it uniquely identifies a person or could be used to reconstruct their full identity, it stays with the verification provider. Antigen stores only what is necessary to assert the claim type, assurance level, and expiry.

### Sensitive Evidence Vault (post-launch, explicitly out of scope)

A future Sensitive Evidence Vault may support encrypted raw document custody for use cases where the user needs to hand off a document directly (e.g., to a website requiring a copy). That feature is **not part of Verification v1** and must not be designed into v1 code paths.

If a future session proposes building it, the following constraints apply regardless:

- Client-side encryption before any upload (user controls the key or authorizes a KMS key)
- Per-disclosure user approval — no standing access; each share requires explicit consent
- Disclosed only to verified, user-approved parties with a stated purpose
- Full `DisclosureReceipt` for every document share
- User-initiated deletion on request
- Agents never receive raw document files or byte content, only signed references
- No agent-readable URL to the raw document

### Agent and website surfaces

**Tier 1 trust signals** — agents and websites always receive (in active delegation context):
- Claim type, signal boolean, assurance_level, expires_at, signal_jws
- `raw_document_revealed_to_agent: false` (TypeScript literal)

**Tier 1 trust signals** — agents and websites never receive:
- Institution name, enrollment status, military branch, business name, email domain, gov ID country
- Any claim field value that reveals personal detail
- `provider_reference_id` or any internal provider reference
- `card_jws` or `card_hash`

**Tier 2 scoped claim details** — agents and websites receive (only with policy or approval):
- Normalized `claim_value` (institution name, enrollment status, country_of_issue, etc.)
- `DisclosureReceipt` receipt_id confirming the disclosure
- `raw_document_revealed_to_agent: false` (TypeScript literal)

**Always forbidden** — agents and websites never receive regardless of tier:
- Raw document data of any kind
- Document numbers, SSNs, full legal name, DOB, physical address
- Biometric data
- Full provider response payloads
- `card_jws` or `card_hash`
- Other claims on the card beyond the specifically requested claim type

---

## Anti-Goals

The following are explicitly out of scope and should not be built or implied:

- **Antigen is not a KYC provider.** Document inspection, liveness checks, and fraud scoring belong to the provider. Antigen only stores the normalized result.
- **No raw document storage in v1.** No encrypted blob for passport images, no S3 uploads, no base64-encoded ID scans. A future Sensitive Evidence Vault is post-launch.
- **No government ID number or SSN storage.** Even encrypted. Not in v1.
- **No biometric matching.** Facial recognition, fingerprints, and voice matching are not Antigen's surface.
- **No full credit file or financial identity.** Antigen does not integrate with credit bureaus.
- **No automatic disclosure of claim details.** Trust signals (boolean availability flags) may be automatic in active delegation contexts. Specific claim field values — institution name, military branch, business name, gov ID country, etc. — require `agent_visible`, `website_allowed`, or per-request approval. There is no "all agents can see everything" mode.
- **Trust signals are not sensitive personal data.** `verified_human_backed: true` and `student_status_available: true` are trust infrastructure signals, not identity exposure. Treating them as requiring the same protection as raw documents would prevent the product from being useful.
- **No public verification query surface.** Third-party websites and agents cannot query any arbitrary user's verification status. Trust signals require an active delegation token — they are scoped to the delegating user's agent.
- **No agent self-verification.** Agents cannot verify themselves as humans. Verification is always about the human user.
- **No broad identity bundle.** Agents request specific claim types, not "give me everything you know about this user."
- **No persistent provider relationship.** Providers are not given ongoing access to user data after the verification session completes.
- **Provider integrations are post-v1.** v1 uses mock providers only.
