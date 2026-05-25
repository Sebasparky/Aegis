# Payment/Card Step Handoff — Design + Test Harness

> **Status: Payment Card Fill Handoff v1 is complete. Purchase Confirmation Handoff v1 is complete.**
> Both halves of the two-phase payment boundary are implemented and tested (830 tests passing as of 2026-05-23).
> See the Manual Test Instructions sections below for end-to-end testing of each phase.

---

## Runtime Binding Requirement

> **Critical for any smoke test or agent flow:** Always call `get_runtime_browser_endpoint` before requesting payment card fills or purchase confirmations. Pass the returned `browser_runtime_id` as `browser_session_id` in every payment tool call.

Without `browser_session_id`, Aegis falls back to the static `AEGIS_PLAYWRIGHT_CDP_URL` env var. If that port does not match the active runtime (or is unset), CDP injects into the wrong page or fails with `CDP_FILL_FAILED: element not found` — even when your selectors are correct.

| If you see... | First check... |
|---|---|
| `CDP_FILL_FAILED: element not found` | Was `browser_session_id` passed? Does it match the runtime that has the checkout page open? |
| `CDP_FILL_FAILED: no page found for domain` | Is the agent browser actually on the checkout page before calling execute? |
| Fills succeed but purchase execute fails | Pass the same `browser_session_id` to `request_purchase_confirmation` as well. |

**Step 0 for every smoke test:**
```bash
# 1. Get the runtime browser endpoint (provisions or reuses the Aegis runtime Chrome)
curl -s -X POST http://localhost:4000/api/agent/v1/runtime/browser-endpoint \
  -H "Authorization: Bearer <your-token>" | jq .
# Note: browser_runtime_id (e.g. tbsess_...) — use as browser_session_id in all payment tools
```

Or via MCP: call `get_runtime_browser_endpoint` and note `browser_runtime_id`.

---

## Manual Test Instructions — Payment Card Fill Handoff v1

### Prerequisites

```bash
# Terminal 1: API server
cd apps/api && npm run dev    # port 4000

# Terminal 2: Web app (approval UI)
cd apps/web && npm run dev    # port 3000

# Terminal 3: Mock store
cd apps/mock-store && npm run dev   # port 3001
```

### Step 0 — Get the runtime browser endpoint

```bash
curl -s -X POST http://localhost:4000/api/agent/v1/runtime/browser-endpoint \
  -H "Authorization: Bearer <your-token>" | jq .
```

Note the `browser_runtime_id` (e.g. `tbsess_...`). Use this as `browser_session_id` in all subsequent payment card fill and purchase confirmation requests.

### Step 1 — Add a test payment method

In the Aegis UI or via direct API call:

```bash
curl -s -X POST http://localhost:4000/api/payment-methods \
  -H "Content-Type: application/json" \
  -d '{
    "label": "Visa Test Card",
    "cardholder_name": "Jane Test",
    "card_number": "4242424242424242",
    "cvv": "123",
    "exp_month": 12,
    "exp_year": 2027,
    "billing_zip": "12345"
  }' | jq .
```

Note the `payment_method_id` from the response (e.g. `pm_...`).

### Step 2 — (Already done in Step 0) Runtime browser session

The `browser_runtime_id` returned in Step 0 is the session ID. You do not need a separate `start_task_browser_session` call. If you are not using the MCP tool server, Step 0 covers this.

### Step 3 — Agent navigates to mock Stripe checkout

In the agent browser (via Playwright MCP or similar):
```
http://localhost:3001/stripe-checkout.html
```

Verify the page shows:
- All 5 card input fields (empty)
- "Pay $12.99" button
- "Test checkout only — no real payment." banner

### Step 4 — Request card fills for each field

Call `request_payment_card_fill` (or POST directly) for each field. You can batch all fields or do them one at a time — they will share the same `authorization_id` if the domain/payment_method match.

**Always pass `browser_session_id: <browser_runtime_id>` (from Step 0).** Missing this causes CDP to target the wrong port and fails with `element not found` even when selectors are correct.

```bash
# Example: request card_number fill
curl -s -X POST http://localhost:4000/api/agent/v1/payment-card-fills \
  -H "Authorization: Bearer <your-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "domain": "localhost",
    "field": "card_number",
    "page_url": "http://localhost:3001/stripe-checkout.html",
    "reason": "fill card number for checkout",
    "element_hint": { "selector_hint": "input[name=\"cardnumber\"]" },
    "browser_session_id": "<browser_runtime_id>"
  }' | jq .
```

Repeat for: `expiry_combined`, `cvv`, `cardholder_name`, `billing_zip`

Field → selector mapping:
| `field` value | `selector_hint` |
|---|---|
| `card_number` | `input[name="cardnumber"]` |
| `expiry_combined` | `input[name="exp-date"]` |
| `cvv` | `input[name="cvc"]` |
| `cardholder_name` | `input[name="cardholder-name"]` |
| `billing_zip` | `input[name="postal"]` |

All requests will return `status: "pending_approval"`.

### Step 5 — Approve in the Aegis UI

Navigate to `http://localhost:3000/route-run-approvals`.

A **"Payment card fill request"** card (amber accent) will appear showing:
- Visa Test Card ···4242
- Requested fields as pills (card_number/cvv in red, others neutral)
- Warning: "This fills card details only. It does not authorize a purchase. A separate approval is required before any payment is submitted."

Click **"Allow card fill for Visa Test Card ···4242"**.

### Step 6 — Execute each fill

```bash
curl -s -X POST http://localhost:4000/api/agent/v1/payment-card-fills/<fill_request_id>/execute \
  -H "Authorization: Bearer <your-token>" \
  -H "Content-Type: application/json" \
  -d '{}' | jq .
```

Repeat for each `fill_request_id`.

### Step 7 — Verify the results

**In the agent browser:** Inspect the checkout page. All five fields should be filled:
- `input[name="cardnumber"]` → `4242 4242 4242 4242` (masked in DOM — `.value` returns `""`)
- `input[name="exp-date"]` → `12/27`
- `input[name="cvc"]` → `123` (masked in DOM — `.value` returns `""`)
- `input[name="cardholder-name"]` → `Jane Test`
- `input[name="postal"]` → `12345`

**URL must still be:** `http://localhost:3001/stripe-checkout.html`
(If it changed to `stripe-confirmation.html`, the Pay button was clicked — test failure.)

**Sensitive receipts:**
```bash
curl -s "http://localhost:4000/api/internal/sensitive-receipts/recent?event_group=payment" | jq .
```
Should show `payment_card_fill_executed` events for each filled field.

**Every execute response must contain:**
```json
{
  "raw_values_revealed_to_agent": false,
  "purchase_not_authorized": true
}
```

### Step 8 — Verify the Pay button was NOT clicked

The page URL must remain `stripe-checkout.html`. Navigating to `stripe-confirmation.html` is a failure condition.

The `stripe-confirmation.html` page includes a prominent warning if reached during card fill testing.

### Step 9 — (Optional) Proceed to Purchase Confirmation

After all card fields are filled, the agent may proceed to the second approval phase. See **Manual Test Instructions — Purchase Confirmation Handoff v1** below for the full end-to-end sequence.

### Strict guard lines (do not cross in tests or production code)

- Do NOT add logic to click `#pay-button` in `paymentCardFill.ts` — card fill never clicks
- Do NOT submit the form via CDP `requestSubmit()`, keyboard `Enter`, or any click during card fill
- Do NOT use the Stripe test card numbers with a real Stripe API
- Do NOT pass a `PaymentCardFillAuthorization` ID (`pca_...`) to the purchase confirmation execute endpoint — it returns `403 CARD_FILL_AUTH_NOT_SUFFICIENT`

---

## Manual Test Instructions — Purchase Confirmation Handoff v1

### Prerequisites

Same as card fill: API server (port 4000), web app (port 3000), mock store (port 3001), runtime browser session from Step 0 of the card fill test, card fields already filled.

### Step 0 — Ensure you have the runtime browser_session_id

If continuing from the card fill test, you already have `browser_runtime_id` from that Step 0. Otherwise call `get_runtime_browser_endpoint` again — it will return the existing session (`reused_existing: true`).

### Step 1 — Request purchase confirmation

Pass `browser_session_id: <browser_runtime_id>` so Aegis targets the correct runtime page at execute time.

```bash
curl -s -X POST http://localhost:4000/api/agent/v1/purchase-confirmations \
  -H "Authorization: Bearer <your-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "domain": "localhost",
    "page_url": "http://localhost:3001/stripe-checkout.html",
    "merchant": "Mock Store",
    "amount": 12.99,
    "currency": "USD",
    "item_summary": "Test item",
    "payment_method_label": "Visa Test Card",
    "payment_method_last4": "4242",
    "button_text": "Pay $12.99",
    "browser_session_id": "<browser_runtime_id>",
    "reason": "completing test purchase"
  }' | jq .
```

Note the `purchase_confirmation_id` (e.g. `pconf_...`).

Response will include `status: "pending_approval"` and `purchase_action_authorized: false`.

### Step 2 — Approve in the Aegis UI

Navigate to `http://localhost:3000/route-run-approvals` and scroll to the **Purchase confirmations** section.

A **"Purchase Confirmation"** card (red/critical accent) will appear showing:
- Merchant: Mock Store
- Amount: **$12.99 USD** in large bold text
- Item: Test item
- Payment method: Visa Test Card ···4242
- Button to click: `Pay $12.99`
- Warning banner: "Approving this may complete a purchase, payment, or subscription."

Click **"Approve payment submission"**.

### Step 3 — Poll until approved

```bash
curl -s "http://localhost:4000/api/agent/v1/purchase-confirmations/<purchase_confirmation_id>" \
  -H "Authorization: Bearer <your-token>" | jq .status
```

Should return `"approved"` once the user approves.

### Step 4 — Execute the purchase confirmation

```bash
curl -s -X POST "http://localhost:4000/api/agent/v1/purchase-confirmations/<purchase_confirmation_id>/execute" \
  -H "Authorization: Bearer <your-token>" \
  -H "Content-Type: application/json" \
  -d '{}' | jq .
```

Expected response:
```json
{
  "purchase_confirmation_id": "pconf_...",
  "outcome": "submitted",
  "raw_values_revealed_to_agent": false
}
```

### Step 5 — Verify results

**In the agent browser:** The URL should now be `http://localhost:3001/stripe-confirmation.html`.

**Sensitive receipts:**
```bash
curl -s "http://localhost:4000/api/internal/sensitive-receipts/recent?event_group=payment" | jq .
```

Should show both `payment_card_fill_executed` events and a `purchase_confirmation_submitted` event.

**Verify the two-approval boundary:**
```bash
# Attempting to execute a card fill auth ID at the purchase endpoint must return 403
curl -s -X POST "http://localhost:4000/api/agent/v1/purchase-confirmations/pca_fake/execute" \
  -H "Authorization: Bearer <your-token>" | jq .error
# → "CARD_FILL_AUTH_NOT_SUFFICIENT"
```

### Strict guard lines (purchase confirmation)

- Do NOT call `execute` without a `status: "approved"` authorization — returns 400
- Do NOT pass a `pca_...` (card fill authorization) ID to the purchase execute endpoint — returns 403
- `manual_step_required` outcome is NOT marked as `submitted` — authorization stays `pending_approval`/`approved`
- `safeDisconnect()` is used, never `browser.close()` — the agent's browser session remains intact
- Receipt contains no card number, CVV, PAN, ciphertext, cookies, storage, or KMS material

---

## Dependency

**Payment Methods backend and UI must exist before this feature is implemented.**

Payment Methods v1 requirements (tracked separately):
- Users can save payment methods (card label, last4, network, billing country)
- One payment method can be marked as default
- Payment methods are user-scoped — not linked to any specific domain or merchant
- Full card number, CVV, and expiry are encrypted/sealed server-side and never returned to any caller

This document assumes `PaymentMethodCapability` (label, last4, network, payment_method_id) exists and is accessible via an internal store. No implementation of payment method storage belongs here.

---

## Problem

Credential Step Handoff v1 lets Antigen fill username/password via CDP and submit a login form under a single user approval. Payment requires a strictly harder trust boundary:

1. Filling card fields on a checkout page is a sensitive action — but it does not commit money.
2. Clicking "Place order" / "Pay" commits money, may be irreversible, and must have its own explicit user approval.

These two actions must **never** share an authorization record. A card fill approval is legally and semantically different from a purchase authorization. Collapsing them would let a malicious or mistaken agent convert card fill approval into a purchase.

---

## Core Product Rule

> **Two separate, independent approvals are always required for payment.**

| Step | Who acts | Approval required |
|---|---|---|
| Navigate to checkout, read cart, identify fields | Agent (ordinary browsing via antigen-browser) | None |
| Fill card number, expiry, CVV, billing fields | Antigen via CDP | **Approval 1: Card Fill Authorization** |
| Continue browsing, review order summary | Agent (ordinary browsing) | None |
| Click "Place order" / "Pay" / "Confirm purchase" | Antigen via CDP | **Approval 2: Purchase Confirmation Authorization** |

A **Card Fill Authorization** (`purchase_not_authorized: true` literal on the type) **never** authorizes a purchase. The purchase confirmation execution endpoint must hard-reject any Card Fill Authorization presented in its place.

---

## What Antigen Does and Does Not Do

**Antigen does:**
- Fill card number, expiry, CVV, billing name/zip/address into form fields via CDP
- Mask card number and CVV field `.value` getter after fill (same pattern as password masking)
- Return control to agent after fill — no navigation, no button clicks
- Click the final purchase/pay button after a separate, explicit purchase confirmation approval
- Generate a signed receipt for each step

**Antigen does not:**
- Drive ordinary browsing (finding products, reading the cart, comparing options — these are agent tasks)
- Click "Place order" during the card fill step under any circumstances
- Expose raw card values, CVV, or PAN in any agent-facing response, receipt, or log
- Become a general-purpose browser automation layer

---

## Proposed Authorization Types

### Proposed: PaymentCardFillAuthorization

```
authorization_id     "pcfauth_..."
user_id
delegation_id
domain               hostname only (e.g. "shop.example.com")
page_url             full checkout page URL at time of request
payment_method_id    opaque ID — never a raw card number
payment_method_label display label (e.g. "Visa ending 4242")
payment_method_last4 4 digits only
fields_requested     array of: card_number | expiry_month_year | cvv |
                       billing_name | billing_zip | billing_address
purpose              "checkout_card_fill" (literal)
reason               agent-provided, sanitized, max 200 chars
status               pending_approval → approved → fulfilled
                     | denied | expired | revoked
purchase_not_authorized   true (TypeScript literal — type system enforces boundary)
raw_values_revealed_to_agent  false (TypeScript literal)
created_at / expires_at   5-minute TTL
approved_at / fulfilled_at
```

**Status machine:** `pending_approval → approved → fulfilled` (all fields filled), or terminal: `denied`, `expired`, `revoked`.

### Proposed: PurchaseConfirmationAuthorization

```
authorization_id     "pconfauth_..."
user_id
delegation_id
domain
page_url
merchant             sanitized agent-provided merchant name
amount_usd           optional — agent-detected amount
currency             optional
amount_unknown       true when agent cannot detect amount
item_summary         optional, max 200 chars, sanitized
button_text          exact visible text of the purchase button
payment_method_id
payment_method_label
payment_method_last4
card_fill_authorization_id   optional link to preceding card fill
purpose              "purchase_confirmation" (literal)
reason               sanitized, max 200 chars
risk_level           "high" | "critical" — always at least high
status               pending_approval → approved → fulfilled
                     | denied | expired | revoked
approval_blocked     true if amount exceeds collar spending limit
approval_block_reason
raw_values_revealed_to_agent  false (literal)
created_at / expires_at   5-minute TTL
approved_at / fulfilled_at
```

**Invariant:** The purchase confirmation execution endpoint must check that it holds a `PurchaseConfirmationAuthorization` — not a `PaymentCardFillAuthorization`. A fulfilled card fill authorization is irrelevant and must be rejected.

---

## Proposed MCP Tools

> All tool names and schemas are proposed. Final naming may change.

| Tool | Purpose |
|---|---|
| `request_payment_card_fill` | Agent requests Antigen fill card fields. Creates `PaymentCardFillAuthorization`. Returns `card_fill_request_id`, `authorization_id`, status, and approval URL. |
| `wait_for_payment_card_fill_authorization` | Polls authorization status until `approved`, `denied`, or `expired`. Agent calls this after `request_payment_card_fill`. |
| `execute_payment_card_fill_handoff` | Triggers CDP card field injection after authorization is `approved`. Returns `filled`, `partial_fill`, `blocked_policy`, or `failed`. No purchase button is clicked. |
| `request_purchase_confirmation` | Agent requests Antigen click the purchase button. Requires separate authorization. Creates `PurchaseConfirmationAuthorization`. |
| `wait_for_purchase_confirmation_authorization` | Polls purchase authorization status. |
| `execute_purchase_confirmation_handoff` | Triggers button click + generates receipt. Returns `submitted`, `blocked_policy`, `blocked_merchant_mismatch`, or `failed`. |

---

## Proposed Agent API Endpoints

> All endpoints are proposed. Placement, naming, and grouping may change.

```
POST   /api/agent/v1/payment-card-fills
GET    /api/agent/v1/payment-card-fills/:id
POST   /api/agent/v1/payment-card-fills/:id/execute

POST   /api/agent/v1/purchase-confirmations
GET    /api/agent/v1/purchase-confirmations/:id
POST   /api/agent/v1/purchase-confirmations/:id/execute
```

### Proposed: Card Fill Create — Input

```json
{
  "browser_session_id": "(optional) Aegis-managed task browser",
  "external_cdp_url":   "(optional) Agent's own CDP endpoint",
  "domain":             "shop.example.com",
  "page_url":           "https://shop.example.com/checkout",
  "payment_method_id":  "(optional if use_default_payment_method is true)",
  "use_default_payment_method": false,
  "fields": {
    "card_number":     { "selector": "#cc-number" },
    "expiry":          { "selector": "#cc-exp" },
    "cvv":             { "selector": "#cc-cvc" },
    "billing_zip":     { "selector": "#billing-zip" }
  },
  "reason": "Filling card details for order checkout"
}
```

### Proposed: Card Fill Create — Output

```json
{
  "card_fill_request_id": "pcfill_...",
  "authorization_id":     "pcfauth_...",
  "status":               "pending_approval",
  "payment_method_label": "Visa ending 4242",
  "payment_method_last4": "4242",
  "raw_values_revealed_to_agent": false,
  "expires_at": "...",
  "next_action": {
    "action":       "wait_for_approval",
    "description":  "User must approve card fill in the Aegis approvals UI.",
    "approval_url": "/route-run-approvals"
  }
}
```

### Proposed: Card Fill Execute — Output

```json
{
  "status":               "filled",
  "filled_fields":        ["card_number", "expiry_month_year", "cvv"],
  "raw_values_revealed_to_agent": false,
  "payment_method_label": "Visa ending 4242",
  "payment_method_last4": "4242",
  "next_action": {
    "recommended": "continue_checkout",
    "reason":      "Card fields filled. Agent should review the order summary, then call request_purchase_confirmation when ready to submit."
  }
}
```

### Proposed: Purchase Confirmation Create — Input

```json
{
  "browser_session_id": "(optional)",
  "external_cdp_url":   "(optional)",
  "domain":             "shop.example.com",
  "page_url":           "https://shop.example.com/checkout/review",
  "button_selector":    "#place-order-btn",
  "button_text":        "Place order",
  "merchant":           "Example Shop",
  "amount_usd":         49.99,
  "currency":           "USD",
  "item_summary":       "1x Aegis T-Shirt (L) — $49.99",
  "payment_method_id":  "pm_...",
  "card_fill_authorization_id": "pcfauth_...",
  "reason": "Submitting order after reviewing cart"
}
```

### Proposed: Purchase Confirmation Execute — Output

```json
{
  "status":    "submitted",
  "receipt_id": "pconfreceipt_...",
  "current_url": "https://shop.example.com/order/confirmation",
  "raw_values_revealed_to_agent": false,
  "next_action": {
    "recommended": "read_confirmation",
    "reason":      "Order submitted. Agent should read the confirmation page for order ID and estimated delivery."
  }
}
```

---

## Proposed Internal Approval Endpoints

> For the Aegis UI approval surface only. Not exposed to external agents.

```
GET    /api/internal/payment-card-fill-authorizations
POST   /api/internal/payment-card-fill-authorizations/:id/approve
POST   /api/internal/payment-card-fill-authorizations/:id/deny

GET    /api/internal/purchase-confirmation-authorizations
POST   /api/internal/purchase-confirmation-authorizations/:id/approve
POST   /api/internal/purchase-confirmation-authorizations/:id/deny
```

---

## Proposed Validation Rules

### Card Fill Validation

1. `page_url` must be `http://` or `https://`; `new URL(page_url).hostname` must equal `domain`.
2. One of `payment_method_id` or `use_default_payment_method: true` required.
3. At least one field in `fields` required.
4. Field selectors must not include `button`, `submit`, `[type=submit]`, or `form` — these are not card fields.
5. At execution time: authorization `status` must be `"approved"`.
6. At execution time: active CDP page hostname must match `authorization.domain`.
7. During CDP fill: zero button clicks permitted. Any detected attempt to click a purchase/submit button → `blocked_policy`.

### Purchase Confirmation Validation

**Button text allowlist** (case-insensitive, required to pass):
- `pay`, `pay now`, `place order`, `submit payment`, `confirm purchase`, `confirm order`, `confirm booking`, `subscribe`, `buy now`, `checkout`, `complete purchase`, `complete order`

**Button text blocklist** (always blocked regardless of selector):
- `delete`, `remove account`, `transfer`, `withdraw`, `send`, `post`, `publish`, `close account`, `deactivate`, `cancel subscription`, `sign out`

Additional rules:
1. At execution time: current page `hostname` must equal `authorization.domain` → `blocked_merchant_mismatch` if mismatch.
2. At execution time: authorization must be `PurchaseConfirmationAuthorization` with `status: "approved"` — `PaymentCardFillAuthorization` is never accepted here.
3. If collar `spending_limits.max_with_approval` is defined and `amount_usd` is provided and `amount_usd > max`: `approval_blocked: true` at creation time.
4. `item_summary` max 200 chars; sanitized via `sanitizeReceiptText`.
5. `merchant` max 100 chars; sanitized via `sanitizeReceiptText`.
6. If `amount_usd` is omitted: `amount_unknown: true`; approval copy must read "Amount: Unknown — verify the cart total before approving."

---

## Proposed Sensitive Boundary Behavior

### Card Fill

- CDP injection adapts the existing password masking pattern:
  - `card_number` and `cvv`: mask `.value` getter to return `"*".repeat(length)` after fill.
  - `expiry`, billing fields: masked for consistency.
- After all requested fields are filled: **return control to agent immediately**. No navigation, no button click.
- Agent continues checkout (reads order review page, verifies totals) before calling `request_purchase_confirmation`.
- If card fields are inside payment iframes (Stripe Elements, Braintree): CDP injection must attach to the iframe's target via `Target.getTargets` + URL pattern match; iframe isolation already prevents agent reading injected values, but masking is applied regardless.
- `partial_fill` returned if only a subset of requested fields exist on the page (common in saved-card flows requiring only CVV re-entry).

### Purchase Confirmation

- Antigen clicks the approved button only after `PurchaseConfirmationAuthorization.status === "approved"`.
- Wait for page state: `waitForLoadState("domcontentloaded", 5s timeout)`.
- Outcome classification:
  - URL changed to confirmation pattern → `submitted`
  - Error signals on page → `failed`
  - No clear signal within timeout → `manual_step_required`
- Receipt generated immediately on button click attempt, regardless of outcome.
- `browser.disconnect()` (not `browser.close()`) in `finally` block to preserve agent's browser session.

---

## Proposed Receipt Design

### PaymentCardFillReceipt

```
receipt_id               "pcfreceipt_..."
receipt_type             "payment_card_fill"
schema_version           "1.0"
issuer                   "aegis"
user_id
delegation_id
domain
merchant                 (if available from request context)
payment_method_label
payment_method_last4
fields_filled            array of PaymentCardField names — no values
raw_values_revealed_to_agent  false (literal)
authorization_id
created_at
verification             { canonical_payload_hash, jws, jws_present, signing_alg: "EdDSA", signed_at }
```

### PurchaseConfirmationReceipt

```
receipt_id               "pconfreceipt_..."
receipt_type             "purchase_confirmation"
schema_version           "1.0"
issuer                   "aegis"
user_id
delegation_id
domain
merchant
amount_usd               (if known)
currency                 (if known)
amount_unknown           boolean
item_summary             (sanitized, if provided)
payment_method_label
payment_method_last4
button_text
status                   "submitted" | "failed" | "blocked"
blocked_reason           (if blocked)
authorization_id
card_fill_authorization_id   (optional, links preceding fill)
raw_values_revealed_to_agent  false (literal)
created_at
verification             { canonical_payload_hash, jws, jws_present, signing_alg: "EdDSA", signed_at }
```

Both receipt types should surface in the sensitive receipt timeline (`GET /api/internal/sensitive-receipts/recent`) under `event_group: "payment"`.

---

## Proposed UI Design

### PaymentCardFillApprovalCard

- **Header**: "Card Fill Request" with a payment card icon
- **Domain/URL**: shows `domain` and the checkout page origin
- **Payment method**: `payment_method_label` + last4 chip + "Default" badge if applicable
- **Fields requested**: pill list of human-readable field names (e.g. "Card Number", "Expiry", "CVV", "Billing ZIP")
- **Warning banner (yellow)**: "This fills your card details on the checkout form. It does **not** authorize a purchase. A separate approval is required before any payment is submitted."
- **Expires countdown** (same 8-second auto-refresh polling as existing approval cards)
- **Approve / Deny** buttons

### PurchaseConfirmationApprovalCard

- **Header**: "Purchase Confirmation" — stronger visual weight (red border, shield icon)
- **Merchant name**: prominent, large text
- **Amount block**:
  - Known: amount in large bold text with currency symbol
  - Unknown: "Amount: **Unknown** — Verify the cart total before approving." in amber/orange
- **Item summary**: shown if provided, truncated at 200 chars
- **Payment method**: `payment_method_label` + last4
- **Button label**: "Will click: [button_text]" (e.g., "Will click: Place order")
- **Risk indicator**: HIGH or CRITICAL risk pill
- **Warning banner (red)**: "This will complete the purchase. This action may be irreversible."
- **Approve / Deny**: Approve is styled as a commitment action (filled, high-contrast color). Single explicit click required.
- **Expires countdown**

---

## Proposed Relationship to Login Handoff

### Shared concepts

- Antigen-browser adapter as agent browsing layer
- Agent drives ordinary browsing; Antigen handles only sensitive micro-steps
- CDP injection via WebSocket (`Target.attachToTarget` + `Runtime.evaluate`)
- `SensitiveGrant` one-use authority grant created at approval time
- `UserApprovalReceipt` signed at approve/deny time
- Status machine: `pending_approval → approved → fulfilled` | terminal states
- 5-minute authorization TTL

### Key differences

| | Login Handoff | Payment Handoff |
|---|---|---|
| Approvals needed | 1 (username + password + submit) | **2** (card fill, then purchase) |
| Submit in same approval | Yes | **Never** |
| Action type | `"login"` | `"payment"` / `"purchase"` |
| Risk level | medium / high | always high or critical |
| Field masking | Password returns `""` | Card number / CVV returns `"*"` repeat |
| Receipts generated | 1 | **2** (card fill receipt + purchase receipt) |
| Collar spending limit check | No | Yes (if `amount_usd` provided) |

---

## Proposed Implementation Sequence

> This is a planning reference. Nothing below has been implemented.

1. **Types** (`packages/types/src/index.ts`)
   - `PaymentCardField` union type
   - `PaymentCardFillAuthorization` with `purchase_not_authorized: true` literal
   - `CardFieldFillRequest`, `PaymentCardFillResult`
   - `PurchaseConfirmationAuthorization`
   - `PurchaseConfirmationRequest`, `PurchaseConfirmationResult`
   - `PaymentCardFillReceipt`, `PurchaseConfirmationReceipt`
   - Extend `SensitiveGrantType` union with `"payment_card_fill"` and `"purchase_confirmation"`

2. **In-memory stores** (`apps/api/src/store/index.ts`)
   - `paymentCardFillAuthorizations: Map<string, PaymentCardFillAuthorization>`
   - `cardFieldFillRequests: Map<string, CardFieldFillRequest>`
   - `purchaseConfirmationAuthorizations: Map<string, PurchaseConfirmationAuthorization>`
   - `purchaseConfirmationRequests: Map<string, PurchaseConfirmationRequest>`

3. **Runtime logic** (new file: `apps/api/src/runtime/paymentCardHandoff.ts`)
   - `executeCardFieldFillViaCDP()` — adapts `secretInjection.ts`; adds card field masking; returns `filled_fields[]`
   - `executePurchaseConfirmationHandoff()` — adapts `credentialStepHandoff.ts`; applies allowlist/blocklist; merchant/domain check; outcome classification; receipt creation
   - `PURCHASE_BUTTON_ALLOWLIST` regex
   - `PURCHASE_BUTTON_BLOCKLIST` regex (coordinate with existing blocklist in `credentialStepHandoff.ts`)

4. **Agent API routes** (additions to `apps/api/src/routes/agent-api.ts`)
   - 6 endpoints listed above

5. **Internal routes** (new file: `apps/api/src/routes/payment-handoff.ts`)
   - 6 internal endpoints; lazy expiry on list; `SensitiveGrant` created at approve time; signed `UserApprovalReceipt`

6. **Approval UI** (`apps/web/src/app/route-run-approvals/page.tsx`)
   - `PaymentCardFillApprovalCard` component
   - `PurchaseConfirmationApprovalCard` component
   - Wire to new internal endpoints; 8-second auto-refresh polling

7. **MCP tools** (`examples/aegis-tool-server.mjs`)
   - 6 tools: request + wait + execute for each authorization type

8. **Tests** (`apps/api/src/__tests__/payment-card-handoff.test.ts`)
   - Full test list below

---

## Proposed Tests

> Tests are proposed only. No test file exists yet.

### Boundary enforcement
1. Card fill authorization (approved or fulfilled) rejected at purchase execute endpoint → `403 CARD_FILL_AUTH_NOT_SUFFICIENT`
2. Purchase execute with no `PurchaseConfirmationAuthorization` → `403`
3. CDP script during card fill that detects a purchase button click attempt → `blocked_policy`
4. Fulfilled card fill authorization still rejected at purchase execute endpoint

### Data safety
5. No agent-facing response contains `card_number`, `cvv`, `pan`, `raw_value`, or `secret_ref`
6. `purchase_confirmation` execute response has `raw_values_revealed_to_agent: false`
7. `PaymentCardFillReceipt.fields_filled` contains field names only — no values, no PAN, no CVV

### Validation
8. Request without `payment_method_id` or `use_default_payment_method: true` → `400`
9. `button_text: "delete"` → `400 BUTTON_TEXT_BLOCKED`
10. `button_text: "Place order"` passes validation
11. At execute time: CDP page hostname ≠ authorization domain → `blocked_merchant_mismatch`
12. `amount_usd` omitted → `amount_unknown: true` in authorization and receipt
13. `amount_usd` exceeds collar spending limit → `approval_blocked: true` at creation time
14. Expired authorization at execute time → `410 AUTHORIZATION_EXPIRED`

### Receipt generation
15. Successful card fill → `PaymentCardFillReceipt` with `fields_filled`, no values, `raw_values_revealed_to_agent: false`
16. Failed purchase submit → `PurchaseConfirmationReceipt` with `status: "failed"` still generated
17. Receipts signed → `jws_present: true` when signing key configured

---

## Open Questions

1. **Payment iframes (Stripe Elements, Braintree)**: Most real-world payment forms use hosted iframe fields that isolate card values. CDP injection into iframes requires `Target.getTargets()` + iframe URL matching — different from the main-frame injection path. Should iframe support be required in v1, or documented as a v2 gap?

2. **Multi-step checkout (card number on page 1, CVV on page 2)**: Each page URL would require a separate `PaymentCardFillAuthorization`. Is per-page authorization the right model, or should authorization be scoped to a checkout session (domain + session token)?

3. **Amount detection reliability**: Amount is agent-provided. If the agent passes a wrong amount, the user approves based on that wrong amount. Should Antigen independently read and confirm the page amount at execution time as a secondary check?

4. **Subscription vs. one-time purchase**: `button_text: "Subscribe"` is on the allowlist. Should a `PurchaseConfirmationAuthorization` have a `purchase_kind: "one_time" | "subscription"` field, so the UI can disclose recurring billing explicitly?

5. **`card_fill_authorization_id` optional vs. required**: For now it is optional — agent may call `request_purchase_confirmation` without a preceding Antigen card fill (e.g., the card was already saved/tokenized). Should it be required when Antigen performed the card fill?

6. **`SensitiveGrant` scope**: The existing `SensitiveGrant.scope` has `pass_id` for credentials. Payment grants would use `payment_method_id` in scope instead. Should `payment_method_id` be an optional field on `SensitiveGrant.scope`, or should `SensitiveGrant` be extended with a discriminated union?
