# Antigen Snapshot — Security and Privacy

This document defines what Antigen Snapshot may and may not expose, how sensitive elements are handled, and the policy annotation direction.

---

## External vs. Internal Boundary

Antigen Snapshot maintains a strict split between what agents see and what Antigen stores internally.

| Data | External (agent-facing) | Internal (Antigen-only) |
|------|------------------------|------------------------|
| `ag_*` ref | Yes | Yes |
| Element name, role, kind | Yes | Yes |
| Visible/enabled state | Yes | Yes |
| `href_path` (path portion only) | Yes | Yes |
| Sensitivity annotation | Yes (future v1.1) | Yes |
| x/y coordinates | **No** | Yes |
| Bounding box (width/height) | **No** | Yes |
| `selector_hints` | **No** | Yes |
| Full href | **No** (path only) | Yes |
| `id` attribute | **No** | Yes |
| `cdp_url` | **No** | Never stored in snapshot |
| `user_data_dir` | **No** | Never stored in snapshot |
| `profile_key` | **No** | Never |
| `pass_id` | **No** | Never |
| `secret_ref` | **No** | Never |
| Field values | **No** | Never |
| Cookie values | **No** | Never |
| localStorage / sessionStorage | **No** | Never |
| Raw DOM HTML | **No** | Never |

---

## Coordinates Are Internal

The agent never receives element coordinates. Coordinates are an execution detail:
- They are captured internally via `getBoundingClientRect` at extraction time
- They are revalidated at action time before use
- They feed `clickBoxWithPointer` in `nativePointerRuntime.ts`
- They do not appear in any API response, log line, or receipt

This is a firm boundary. Future features (e.g., dev diagnostics) may expose coarse position hints (e.g., "top-left region"), never raw pixels.

---

## Sensitive Field Handling

### Password Fields

`input[type="password"]` elements:
- Extracted as candidates (they need to be clickable/focusable by agents)
- Marked with `sensitivity: "credential_field"` in the internal record
- `name` set to accessible label (e.g., "Password") — never to the field value
- Field `.value` is **never read**
- Passed to the external snapshot with `sensitivity: "credential_field"`, `state.enabled: true/false`, but no value
- Attempting to `browser_type` into a credential field must go through the Aegis sensitive handoff flow (`request_secret_field_injection`), not direct typing

### Payment Fields

Fields with `autocomplete` values `cc-number`, `cc-csc`, `cc-exp`, `cc-exp-month`, `cc-exp-year`, `cc-name`, `cc-type`:
- Extracted as candidates
- Marked `sensitivity: "payment_field"` internally
- Field `.value` **never read**
- Attempting direct type/fill → `SENSITIVE_ACTION_BLOCKED`; must use Aegis payment handoff

### Hidden Inputs

`input[type="hidden"]`:
- Not extracted as interactive candidates
- Not included in the snapshot at all
- Their values are never read

### Identity / Financial Fields

Fields where `id`, `name`, or `autocomplete` contain `ssn`, `social`, `passport`, `routing`, `account-number`:
- Marked `sensitivity: "credential_field"` or `"unknown_sensitive"` conservatively
- Field `.value` never read

---

## Element Values: redacted current-value metadata (Exact Form-Fill v1)

> **Updated for Exact Form-Fill v1.** The snapshot now exposes a redacted
> `value_meta` for field-like candidates so the agent can detect already-filled
> fields and use the idempotent exact-replacement tools (`browser_set_value`)
> instead of appending. This is a DELIBERATE, SCOPED change to the original
> "never read `.value`" rule, and applies ONLY to the Antigen snapshot — NOT to
> `AgentSafeObservationSnapshot` (which still exposes a `filled` boolean only).

The `name` accessible label is still resolved without reading the value (button
labels excepted, as before). The redaction rules for `value_meta` are:

| Case | Rule |
|------|------|
| Non-sensitive `input`/`textarea` | current `.value` exposed (clipped to 200 chars) as `value_meta.value` |
| `contenteditable` | current `innerText` exposed (clipped) |
| `select` | selected option `value`/visible text exposed (non-sensitive only) |
| `checkbox`/`radio` | `checked` boolean exposed |
| Sensitive fields (credential/payment/identity/financial, or `type=password`) | ONLY `value_present`/`value_length` + flags — `value`/`selected_value`/`selected_text`/`validation_message` are **never** exposed |
| `input[type="hidden"]` | skipped entirely (unchanged) |

Sensitivity is classified by `classifySensitivity` (same patterns as
`agentSafeObservation.ts`). Redaction is enforced in THREE layers: the page IIFE,
`sanitizeValueMeta` (TS, defense-in-depth), and `toExternalAntigenSnapshotElement`
(external view). A raw password/card/CVV value must never appear in any layer.

### Search-Intent Override

Ordinary site/merchant search inputs are NOT sensitive fields — search terms must
be typeable through the generic `browser_type` / `browser_set_value` tools without
the injection handoff. `classifySensitivity` therefore applies a conservative
search-intent override:

- **Strong sensitive rules always win.** The override is consulted only AFTER the
  high-precision rules (`type=password`, `cc-*` autocomplete, CVV/CVC, SSN/passport,
  routing/account-number). A field with `name="search"` and `autocomplete="cc-number"`
  classifies `payment`.
- **The override can only suppress the weak substring heuristics** (the generic
  `password|…|key` and `card|payment|billing|checkout` catch-alls), and only when
  the field carries an explicit search signal: `type="search"`, `role="searchbox"`,
  a search/query/keyword-style token in `name`/`id`, clear search wording in the
  placeholder or `aria-label`, or an ancestor `role="search"` landmark / search form.
- **Vetoes (sensitive context overrides search-like signals):** any credential /
  identity / contact / payment wording in the field's own attributes (password,
  OTP, verification, cvv, card number, email, username, login, phone, address,
  zip, DOB, …), a sensitive autocomplete value, or an ancestor `<form>` whose
  action/id/aria-label indicates checkout / payment / billing / login / register.
- **Fail-closed:** if the override helper throws, classification falls back to the
  stricter pre-override behavior. Fields with no explicit search signal are
  completely unaffected — e.g. a field literally named `giftcard` with no search
  wording still classifies `payment` (known-conservative limitation).

The weak credential heuristic was also tightened: the bare `key` substring (which
misclassified keyword-style search boxes, e.g. `name="field-keywords"`, as
credential fields) is now bounded (`api key` / `passkey` / standalone `key`
tokens still match; `keyword`, `monkey`, `keyboard` do not).

---

## Snapshot Extraction Does Not Execute Actions

The IIFE runs in a read-only mode:
- No clicks, focus events, or form submissions
- No programmatic scroll (visibility check uses current viewport position)
- No writes to DOM properties
- No `fetch`, `XMLHttpRequest`, or network access
- No `localStorage.setItem` or `sessionStorage.setItem`

---

## Policy Annotations

Future v1.1 will annotate elements with a `sensitivity` field indicating what type of action they represent. This is used by Antigen's policy layer to decide whether approval is required before execution.

### Annotation Values

| Value | Meaning | Default policy |
|-------|---------|---------------|
| `ordinary` | Navigation, informational link, read action | Allow |
| `cart_add` | "Add to cart", "Add to bag" | Allow (check collar spending policy) |
| `checkout` | "Checkout", "Place order", "Buy now", payment flow entry | `approval_required` |
| `credential_field` | Password, secret, login field | Must use Aegis credential handoff |
| `payment_field` | Credit card, bank account, payment field | Must use Aegis payment handoff |
| `account_action` | Change email, change password, update profile, connect account | `approval_required` |
| `destructive_action` | Delete account, cancel subscription, remove data | `approval_required` |
| `public_post` | Send message, post publicly, email | `approval_required` |
| `unknown_sensitive` | Unclear but signal suggests sensitivity | `approval_required` (conservative) |

### Annotation Rules

- Annotation is based on element metadata only (name, role, kind, href, id, button text) — never field values
- Element names containing: `pay`, `checkout`, `place order`, `buy now`, `submit order` → `checkout`
- Element names containing: `delete`, `remove`, `cancel`, `close account` → `destructive_action`
- Element names containing: `send`, `post`, `publish`, `share` → `public_post`
- `cart_add` requires both "add" and ("cart" or "bag" or "basket") in the name
- When uncertain, classify as `ordinary` (v1) or `unknown_sensitive` (v1.1 conservative mode)

---

## Receipt Direction

When a sensitive action is executed through the primary or fallback path, future receipt support should record:

- The semantic element name at action time (e.g., `"TERTIAL, Work lamp, light blue"`)
- The `ag_*` ref
- The action kind (`click`, `type`)
- The sensitivity annotation
- The policy outcome (allowed, approval_required, blocked)
- Timestamp

Receipts must **not** record:
- x/y coordinates
- Raw bounding boxes
- Selector hints
- DOM HTML
- Field values
- Cookie or storage state

---

## Forbidden Output Fields — Summary

These must never appear in any agent-facing response, diagnostic payload, log line, or receipt:

```
x, y, width, height, center_x, center_y
box (object containing coordinates)
cdp_url
user_data_dir
profile_key
pass_id
secret_ref
devvault:// references
encrypted blobs
KMS envelopes / ciphertext
raw cookies
storageState
localStorage / sessionStorage values
raw DOM HTML
full innerHTML
full page source
CSS selectors (selector_hints contents)
raw numeric scores (use buckets)
field .value for any input except submit/button/reset
```

---

## Safe Diagnostics

Diagnostic payloads (AMBIGUOUS_ELEMENT, ELEMENT_NOT_FOUND, etc.) must:

- Include semantic info only: `ref`, `role`, `name`, `kind`, `score_bucket`
- Not include coordinates or layout data
- Not include DOM selector strings
- Not include `cdp_url`, session internals, or credential references
- Not include raw score breakdowns (use `score_bucket: "high" | "medium" | "low"`)

Safe:
```json
{ "ref": "ag_21", "role": "link", "name": "TERTIAL, Work lamp, light blue", "score_bucket": "high" }
```

Not safe:
```json
{ "ref": "ag_21", "x": 489, "y": 769, "selector": "a[href*=\"tertial\"]", "score": 110 }
```
