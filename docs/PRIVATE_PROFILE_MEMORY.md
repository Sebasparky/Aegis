# PRIVATE_PROFILE_MEMORY.md

## Purpose

This document defines the product architecture for Private Profile Memory — Antigen's private operational identity layer.

Private Profile Memory lets agents complete workflows without learning unnecessary personal data. It is how Antigen learns about a user operationally, stores that information under controlled policy, and uses it on behalf of agents without exposing raw values.

Core line:

> Antigen learning a value does not mean the value is agent-visible or broadly reusable. Learning and disclosure are separate, independently governed decisions.

---

## Product Problem

During real workflow testing (IKEA checkout, contact form fills, travel booking), agents asked users directly for address and phone number. This is wrong in two ways:

**The agent sees data it does not need to know.**
A shopping agent does not need to know the user's home address. It needs Antigen to fill the address field. The distinction matters because the agent's context is not under the same custody guarantees as Antigen's memory.

**The user is forced to repeat themselves.**
Every checkout session, every contact form, every shipping field — the user answers the same questions again. This is the failure mode of agents that treat every workflow as stateless.

Private Profile Memory solves both. The agent requests a capability ("fill the shipping address"). Antigen resolves it, fills it, and audits it. The agent never sees the raw value.

---

## Product Principle

**Agents request fields or capabilities from Antigen — not raw profile dumps.**

Antigen fills or uses personal data on behalf of agents. Agents do not receive personal data unless policy and user approval explicitly permit it.

Private values are not public to agents by default.

A value being stored in Antigen's memory does not imply:
- The agent may read it.
- It may be used on a different domain.
- It may be used for a different purpose than the one for which it was stored.
- It may be reused without a fresh approval when policy requires approval.

Every memory item carries its own scope, sensitivity tier, provenance, and default disclosure mode. These travel with the item and are evaluated at every use.

---

## Learning Loop

Antigen learns from workflow interruptions. The loop is:

1. Agent needs a field value (e.g., shipping address line 1).
2. Agent calls `request_profile_field_fill` with domain, requested fields, detected selectors, and reason.
3. Antigen checks its memory for a stored, in-scope value for each requested field.
4. **If known and policy allows automatic use:** Antigen fills the field via CDP. Agent receives a masked summary and `raw_profile_value_revealed_to_agent: false`. No user interruption.
5. **If known but policy requires approval:** Antigen surfaces an approval card in the Antigen UI. Agent waits. User approves. Antigen fills. Masked summary returned.
6. **If unknown:** Antigen creates a user prompt request. Agent waits. User answers in the Antigen UI. Antigen stores the value under the appropriate sensitivity, scope, and provenance. Antigen fills the field. Agent receives a masked summary.
7. On future requests for the same field on the same domain, Antigen uses the stored value according to its policy.

**Learning is always user-initiated.** Antigen never infers, guesses, or extracts profile values from page observation. Values enter memory only when the user explicitly provides them (direct answer or import).

---

## Data Classes

Private Profile Memory defines four data classes. The class determines default disclosure mode, whether agent-visibility is ever permitted, and how the value is stored.

### Class 1: Secret-Grade Data

Values that must never be returned to an agent in any form.

Examples: passwords, card numbers, CVV, CVC, PIN, SSN, passport number, driver's license number, bank account number, routing number, biometric identifiers, government-issued document images.

- **Default disclosure mode:** `never` — no disclosure path exists in the tool API
- **Agent-visible:** Never. The field does not exist on agent-facing responses.
- **Storage:** KMS-encrypted, secret_ref indirection. Never in plaintext at rest.
- **Fill:** Via CDP only, with DOM value masking post-fill.
- **Handled by:** Existing Secret Vault and payment card handoff. Private Profile Memory does not manage Class 1 values — this class is listed here to make the boundary explicit.

### Class 2: Private Profile Data

Personally identifying operational values that are sensitive in isolation.

Examples: full legal name, home address, phone number, personal email, date of birth, national ID type (not number), shoe size (when used as identity signal), medical or dietary preferences.

- **Default disclosure mode:** `fill_only` — Antigen fills the field; raw value is not returned to the agent
- **Agent-visible:** Only with explicit per-item `agent_visible_allowed: true` set by the user AND active user approval at use time
- **Storage:** Encrypted at rest. Provenance and scope recorded on every item.
- **Aggregation risk:** Individual items that appear low-risk (shoe size, birthday month) can become identifying when combined. Antigen must not allow agents to request unbounded sets of Class 2 fields in a single call.

### Class 3: Low-Risk Operational Preferences

Preferences that are not sensitive in isolation but may still become identifying in aggregate.

Examples: preferred color, delivery time window, T-shirt size, gift wrapping preference, newsletter opt-in defaults, language preference.

- **Default disclosure mode:** `fill_only` by default; may be relaxed to `agent_visible` per item if user explicitly sets `agent_visible_allowed: true`
- **Agent-visible:** Permitted per item with user-set flag, no additional approval required at use time once flag is set
- **Storage:** Encrypted at rest. Scope and provenance recorded. Aggregation limits apply: an agent may not request more than a bounded set of Class 3 fields per session without approval.
- **Aggregation warning:** Class 3 items requested in bulk across multiple domains or workflows should trigger an aggregation review. Antigen must not silently comply with requests that reconstruct a full behavioral profile.

### Class 4: Public / Non-Sensitive Task Preferences

Values the user has explicitly marked as broadly shareable and that carry no meaningful identity risk individually or in combination.

Examples: preferred measurement system, light/dark mode preference, locale, timezone.

- **Default disclosure mode:** `agent_visible` — raw value may be returned to agent
- **Storage:** May be stored in cleartext. Still carries scope, provenance, and provenance metadata.
- **Note:** Even Class 4 items carry the `PrivateProfileMemoryItem` structure. The schema is uniform — only the policies differ.

---

## Disclosure Modes

Each `PrivateProfileMemoryItem` has a `default_disclosure_mode`. Antigen evaluates this at every use.

| Mode | What the agent receives | When Antigen fills | When used |
|---|---|---|---|
| `fill_only` | Masked summary (`field_filled: true, raw_value_revealed: false`) | Yes, via CDP | Default for Class 2 |
| `use_only` | Antigen uses value for internal matching/decision; result only | No direct field fill | Matching, routing decisions |
| `masked_summary` | Partial representation (e.g., `"*** *** 8472"` for phone) | Yes, via CDP | When agent needs display confirmation |
| `agent_visible` | Raw value returned in API response | Yes, or agent fills directly | Requires `agent_visible_allowed: true` on item |
| `approval_required` | Pending until user approves in Antigen UI | Only after approval | Default for final purchase, new domains |
| `unavailable` | Antigen prompts user to provide value; agent waits | After user provides | When no stored value exists |

**Hierarchy:** `approval_required` overrides any other mode on the item. If the domain policy or collar requires approval, that overrides the item's default mode.

---

## Default Policies

Antigen applies these defaults unless the user or a collar explicitly changes them.

| Field / Category | Default Mode | Agent-Visible Permitted | Approval at Use |
|---|---|---|---|
| Shipping address | `fill_only` | No | No (known domain) |
| Shipping address, new/suspicious domain | `approval_required` | No | Yes |
| Phone number | `fill_only` | No | No (known domain) |
| Full legal name | `fill_only` | No | No (known domain) |
| Personal email (non-login) | `fill_only` | No | No (known domain) |
| Date of birth | `fill_only` | No | Yes always |
| Passwords | `never` (Class 1, out of scope) | Never | N/A |
| Card number / CVV | `never` (Class 1, out of scope) | Never | N/A |
| SSN / government document number | `never` (Class 1, out of scope) | Never | N/A |
| Shoe size, clothing size | `fill_only` | Only if `agent_visible_allowed: true` | No |
| Dietary / medical preferences | `fill_only` | No | No (low-risk domain); Yes (sensitive context) |
| Color preference, delivery window | `fill_only` or `agent_visible` | If `agent_visible_allowed: true` | No |
| Final purchase submission | `approval_required` (handled by PurchaseConfirmationAuthorization) | N/A | Yes always |
| Any Class 2+ field on an unrecognized domain | `approval_required` | No | Yes |

**Collar override:** A collar may tighten but not loosen these defaults. A collar with `identity_disclosure_blocked: true` prevents all Class 2 profile fills regardless of item-level policy.

---

## Memory Record Model

Every stored value is a `PrivateProfileMemoryItem`. The structure is uniform across all classes. The class and disclosure mode travel with the record and are evaluated at every access.

```typescript
interface PrivateProfileMemoryItem {
  memory_id: string;                       // "ppm_..."
  user_id: string;

  key: string;                             // Canonical field name: "shipping_address_line1",
                                           // "phone_e164", "full_legal_name", "shoe_size_us", etc.

  value_ref: string;                       // "ppvault://{memory_id}/value"
                                           // Points to KMS-encrypted blob. Raw value is never stored inline.

  value_type: ProfileValueType;            // "address_line" | "phone" | "email" | "full_name" |
                                           // "date_of_birth" | "size" | "preference" | "locale" | ...

  data_class: 2 | 3 | 4;                   // Class 1 values are out of scope — handled by Secret Vault
                                           // Class 2: private profile; Class 3: low-risk operational;
                                           // Class 4: public preferences

  sensitivity: "private" | "low_risk" | "public";

  default_disclosure_mode: DisclosureMode; // fill_only | use_only | masked_summary |
                                           // agent_visible | approval_required | unavailable

  allowed_contexts: AllowedContext[];      // Domain constraints and purpose constraints
  //  {
  //    domain?: string;                   // If present, value may only be used on this domain
  //    purpose?: ProfileUsePurpose;       // "checkout" | "contact_form" | "account_creation" | ...
  //  }

  agent_visible_allowed: boolean;          // User-set flag. false by default for Class 2.
                                           // Even when true, agent_visible disclosure mode is still
                                           // required at use time — this flag is a pre-condition, not a grant.

  provenance: ProfileValueProvenance;
  //  {
  //    source: "user_provided" | "imported" | "workflow_learned";
  //    workflow_context?: string;         // Human-readable: "IKEA checkout, 2026-05-25"
  //    domain_at_creation: string;        // Domain where user first provided this value
  //  }

  created_at: string;
  updated_at: string;
  last_used_at?: string;
  expires_at?: string;                     // Optional TTL

  user_editable: true;                     // Always — users can always edit or delete
  uses: ProfileValueUse[];
  //  Array of use records, each:
  //  {
  //    used_at: string;
  //    domain: string;
  //    disclosure_mode_applied: DisclosureMode;
  //    agent_visible: boolean;
  //    approval_id?: string;
  //  }
}
```

**Key invariant:** `value_ref` is the only field that contains or references the actual value. The raw value is not stored inline, not in provenance, not in use records, and not in any agent-facing response. Decryption happens only in the Antigen runtime at fill time, consumed immediately by CDP injection, never persisted or returned.

---

## Handoff Flow — `request_profile_field_fill`

This is the primary agent-facing tool for profile-backed field fills.

**Agent call:**

```typescript
request_profile_field_fill({
  browser_session_id: string;            // From start_task_browser_session
  domain: string;                        // Domain of the page being filled
  requested_fields: ProfileFieldRequest[];
  //  [
  //    {
  //      key: "shipping_address_line1",
  //      selector_hint?: string,         // CSS or ARIA selector detected by agent
  //      label?: string,                 // Field label text
  //      reason?: string,               // Why this field is needed
  //    }
  //  ]
  reason: string;                        // Why the agent needs these fields filled
})
```

**Antigen resolution (internal, not agent-visible):**

1. Validate collar — if `identity_disclosure_blocked: true`, return 403.
2. For each requested field, look up `PrivateProfileMemoryItem` by `key` and check `allowed_contexts` includes the current domain.
3. Apply domain novelty check — if domain has not been used with this item before, escalate to `approval_required` regardless of item default.
4. Classify each field's resolution path:
   - **Known, auto-fill permitted:** queue for CDP fill
   - **Known, approval required:** create `ProfileDataFillAuthorization`, return `pending_user_approval`
   - **Unknown:** create `ProfileValuePromptRequest`, return `pending_user_input`
5. For CDP-fill items, decrypt via KMS → inject via CDP `Runtime.evaluate` → mask DOM `.value` post-fill on sensitive fields.
6. Record use in `PrivateProfileMemoryItem.uses`.
7. Return response to agent.

**Agent response:**

```typescript
{
  filled_fields: {
    key: string;
    field_filled: boolean;
    status: "filled" | "pending_user_approval" | "pending_user_input" | "blocked";
    masked_summary?: string;              // e.g., "*** Main St, Ann Arbor, MI 4***"
    raw_profile_value_revealed_to_agent: false;  // Literal false — always on every field
    prompt_request_id?: string;           // Present when pending_user_input
    authorization_id?: string;            // Present when pending_user_approval
  }[];
  all_filled: boolean;
  raw_profile_values_revealed_to_agent: false;   // Literal false — always on root object too
}
```

**Waiting for user input or approval:**

If any field returns `pending_user_input` or `pending_user_approval`, the agent must call `wait_for_profile_fill_resolution(prompt_request_id or authorization_id)` and wait. The agent must not ask the user to type values into chat. The user acts in the Antigen UI; the agent waits via tool polling.

---

## UX

**No giant profile form required.**

Antigen does not onboard users by asking them to fill out a profile. There is no "Profile" setup step. Antigen builds its memory from workflow interruptions — the first time an agent needs a value that Antigen doesn't have, the user is asked in the Antigen UI at that moment, in context.

**What the user sees during a workflow:**

> "The agent needs your shipping address to continue. This will be stored for future use on this site."
> [Address form inline in Antigen UI]
> [Save for this site only | Save for all sites | One-time use]

**After the workflow:**

Users can navigate to the Private Profile Memory section in Antigen to:
- Review every stored value and when it was last used
- See what workflow prompted the storage and on which domain
- Edit any value
- Delete any value
- Set auto-use rules per field per domain (e.g., "always auto-fill shipping address on amazon.com without asking")
- See a log of every time a value was used and in what disclosure mode

**What users are never shown:**

Antigen does not show the agent's internal reasoning, the agent's prompt, or the full raw workflow state. The user sees only: field requested, domain, reason provided by agent, and what Antigen will do.

---

## Security and Privacy Invariants

These are hard rules. They apply to every implementation of Private Profile Memory.

**Learning ≠ Disclosure.**
The fact that Antigen has stored a value does not authorize the agent to see it, request it in full, or use it on other domains. Learning and disclosure are separate decisions governed by separate policies. A stored item is not an accessible item until Antigen evaluates scope, sensitivity, disclosure mode, and collar constraints.

**Raw profile values are never returned to the agent by default.**
`raw_profile_value_revealed_to_agent: false` is a TypeScript literal `false` on every agent-facing field and on the root response object. It must never be set through a variable, never be conditionally set, and never be omitted.

**Private values are encrypted at rest.**
Class 2 and Class 3 values are KMS-encrypted with secret_ref indirection, the same as credential secrets. Plaintext exists only during KMS decryption at fill time, consumed immediately by CDP injection.

**DOM value masking after fill.**
For Class 2 fields (address, phone, name), Antigen masks `el.value` via a DOM property getter after CDP fill, preventing the agent from reading the filled value back from the DOM even if it tries.

**Scope is per-item and per-domain.**
A value stored for checkout.example.com is not automatically available to payments.otherdomain.com. Cross-domain use requires explicit user permission or a collar grant.

**Provenance is permanent.**
Every stored item records how it entered memory (user_provided, imported, workflow_learned), on which domain, and in what workflow context. This record is immutable and cannot be cleared by the agent.

**All uses are auditable.**
Every fill, every masked_summary response, every `agent_visible` disclosure is recorded in `PrivateProfileMemoryItem.uses`. The user can inspect the full use history.

**Aggregation is a first-class concern.**
An agent requesting more than a bounded set of Class 2 or Class 3 fields per session triggers an aggregation review. Antigen must not permit requests that reconstruct a full behavioral profile through repeated individual field requests. The per-call field limit for Class 2 fields is a product-defined constant (default: 8).

**Users can always delete.**
`user_editable: true` is a required literal on every `PrivateProfileMemoryItem`. Deletion is immediate and permanent. Deleted values cannot be recovered, even from fills that already occurred (those are already in use records as booleans, not values).

**Agents cannot read memory directly.**
There is no `get_profile_memory` or `list_profile_fields` tool that returns stored values to agents. Agents may only call `request_profile_field_fill` and receive masked summaries. Memory inspection is a user-only surface.

**Domain constraints are enforced at fill time, not at storage time.**
Storing a value for amazon.com does not prevent the user from later approving its use on another domain. But Antigen re-evaluates domain policy on every fill — it does not cache a blanket cross-domain grant.

**Class 1 values are out of scope.**
Private Profile Memory does not store passwords, card numbers, CVV, SSN, or government document numbers. These remain in the Secret Vault and payment card handoff systems. If an agent requests a field that resolves to a Class 1 value, Antigen returns 403 with `CLASS_1_OUT_OF_SCOPE`.

---

## First Implementation: Private Profile Memory v1

**Scope:** Checkout and contact fields only.

**Supported fields in v1:**
- `full_legal_name`
- `email_address` (non-login, contact use)
- `phone_e164`
- `shipping_address_line1`
- `shipping_address_line2`
- `shipping_city`
- `shipping_state_province`
- `shipping_postal_code`
- `shipping_country`

**What to build:**

1. `PrivateProfileMemoryItem` type in `packages/types/src/index.ts`.
2. In-memory store (`privateProfileMemory: Map<string, PrivateProfileMemoryItem>`) in a new `profileMemory.ts` persistence module. Repository-backed in Supabase path (same dual-write pattern as vault).
3. KMS encryption for Class 2 fields using existing `kms.encryptSecret()` / `kms.decryptSecret()` path. `value_ref` follows the same `ppvault://{memory_id}/value` indirection as `devvault://`.
4. `POST /api/internal/profile-memory/items` — create or update a memory item (user-initiated or workflow-learned).
5. `GET /api/internal/profile-memory/items` — list items for user (metadata only, no values).
6. `DELETE /api/internal/profile-memory/items/:memory_id` — delete item.
7. MCP tool `request_profile_field_fill` — agent-facing, returns masked summaries, `raw_profile_value_revealed_to_agent: false` always.
8. `ProfileValuePromptRequest` model + `POST /api/internal/profile-memory/prompt-requests` — when a value is unknown, creates a pending user prompt visible in Antigen UI.
9. `wait_for_profile_fill_resolution` MCP tool — polls prompt request or authorization until resolved.
10. CDP fill execution — reuse `executeSecretInjectionViaCDP` pattern from `apps/api/src/runtime/secretInjection.ts`. Field-level DOM value masking for Class 2 fields.
11. `ProfileDataFillAuthorization` — one authorization covering multiple fields on one domain, same status machine as `CredentialUseAuthorization` (`pending_approval → approved → fulfilled`), linked `UserApprovalReceipt` (EdDSA signed).
12. Antigen UI: prompt request card at `/route-run-approvals` (reuses approval inbox pattern), profile memory review page at `/profile-memory`.

**Seed values for demo/dev:**
Seed `full_legal_name`, `email_address`, `phone_e164`, and a complete shipping address as Class 2 fill_only items for the demo user, so checkout flows work end-to-end without requiring user input in early testing.

**Security literals required on all v1 agent-facing responses:**

```typescript
raw_profile_value_revealed_to_agent: false   // on each field result
raw_profile_values_revealed_to_agent: false  // on root response
```

Both are TypeScript literal `false` — written as the literal, never through a variable, never conditionally set.

---

## Non-Goals

**No giant profile dashboard first.** The review UI is minimal: list of stored fields with metadata and delete buttons. No form-based onboarding. No profile completion percentage.

**No public profile.** Profile memory is never exposed to websites, third parties, or agents without active fill authorization. There is no shareable profile URL.

**No agent-visible full profile dumps.** There is no API endpoint that returns all stored values to an agent. Agents receive field-by-field masked summaries only.

**No generalized AI memory extraction.** Antigen does not watch agent conversations and infer profile facts from text. Values enter memory only when the user explicitly provides them.

**No raw identity document storage.** Driver's license images, passport scans, biometric data, and SSNs are never stored in Private Profile Memory. The verification system handles identity claims as normalized assertions, not raw documents.

**No replacing payment or credential handoff.** Card fills go through `request_payment_card_fill`. Credential fills go through `request_secret_field_injection`. Private Profile Memory covers the operational identity gap between those two systems — it does not absorb or replace them.

**No cross-agent profile sharing.** A profile item stored for one delegation cannot be read or used by a different agent delegation without a new fill authorization.
