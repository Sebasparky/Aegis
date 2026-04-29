# RAILS_ARCHITECTURE.md

## Purpose

This document defines the technical architecture for Aegis Rails — the verified workflow route system. It is the reference for all implementation sessions working on route recording, verification, execution, or the action API.

See `docs/AEGIS_RAILS.md` for the product-level spec (route lifecycle, schema, registry API, trust tiers). This document is the implementation architecture layer underneath that spec.

## The Three-Layer Architecture

Aegis Rails has three distinct surfaces, each with a separate role. Mixing them is a design error.

```
Layer 1: Browser Extension  →  Teaching surface
Layer 2: Playwright         →  Verification surface
Layer 3: Aegis Action API   →  Execution surface
```

### Layer 1: Browser Extension — Teaching Surface

Humans teach workflows by performing them normally in their own browser. The Aegis browser extension records semantic telemetry during the demonstration. There is no separate "recording browser." The user clicks "Start Recording", completes the workflow once, and clicks "Stop."

The extension produces a recording payload — an ordered list of semantic browser events — that is sent to `POST /api/routes/record` for compilation into a declarative route object.

**What the extension captures (in priority order):**

1. Accessibility role and accessible name (`role`, `name`)
2. Labels and ARIA attributes: `label[for]`, parent `<label>`, `aria-label`, `aria-labelledby`, `aria-describedby`
3. Placeholder and test identifiers: `placeholder`, `data-testid`, `data-cy`, `data-qa`
4. Nearby visible text and section context (preceding sibling text, heading ancestry)
5. Stable CSS selector — ID-based or data-attribute-based preferred; structural fallback only
6. XPath — fallback only, not preferred
7. Screen coordinates — emergency fallback only; never stored as the primary locator

Screenshots are never the primary representation. The extension may capture a screenshot as an optional human-readable preview for the route listing or marketplace, but it is not stored per step and is not used for route matching or execution.

**Why raw DOM event listeners are not enough:**

Raw DOM event listeners (e.g., `document.addEventListener('click', ...)`) produce coordinates and element references. They miss:

- Accessible names — the semantic label that screen readers and Playwright locators use
- Label associations for form fields — `label[for]`, parent label, `aria-labelledby` relationships are not surfaced by click events
- Nearby section context — which form, section, or heading contains this field
- Value sensitivity — whether a typed value should be stored, redacted, or treated as a runtime variable
- Shadow DOM and iframe boundaries — events from inside a shadow root or cross-origin iframe require explicit handling
- Modern framework lifecycle — React and Vue controlled inputs often suppress or retarget native DOM events

The recorder must run a field resolver on every interacted element to produce semantic locators. Raw coordinates and element references alone are insufficient.

**Field Resolver Specification:**

Every interacted element must be resolved through this chain, in priority order:

| Priority | Source |
|---|---|
| 1 | `label[for]` pointing to this input's `id` |
| 2 | Parent `<label>` element wrapping the input |
| 3 | `aria-label` attribute directly on the element |
| 4 | `aria-labelledby` pointing to another element's text content |
| 5 | `placeholder` attribute |
| 6 | `name` attribute |
| 7 | `id` attribute, if it reads as descriptive (not auto-generated) |
| 8 | `input[type]` (e.g., `email`, `search`, `tel`) |
| 9 | Nearest preceding visible text sibling |
| 10 | Nearest ancestor section heading |

For `contenteditable` elements: apply the same chain to the containing element.

For `<select>`, `<textarea>`, and custom UI components: apply the same chain. If the component uses a shadow root, flag the limitation in the compiled route step.

For elements inside iframes: apply the chain within the iframe context. Flag if cross-origin (resolution will be limited).

The resolved field identity — role, accessible name, labels — is what gets stored in the route step. The field value is classified separately by value policy (see below).

### Layer 2: Playwright — Verification Surface

Playwright verifies whether compiled routes still work. It is not the teaching surface and should not be presented to users as the recording interface.

**Playwright's role in Aegis Rails:**

- **Route replay in sandbox environments** — replay a recorded route step by step to check selector resolution
- **Selector confidence testing** — attempt each `RouteLocator` in priority order and record which resolves
- **Frame and iframe handling** — Playwright's `frame()` API handles cross-frame navigation that the extension flags
- **Download verification** — detect and verify that download trigger steps execute correctly
- **Navigation and wait validation** — confirm that `waitForURL`, `waitForSelector`, and network idle conditions behave as expected
- **Regression checks** — run on a schedule to detect website changes that break a published route
- **Route verification before publication** — a route cannot reach `aegis_scanned` tier without passing Playwright replay

Playwright gives the route a confidence score per step. Steps that resolve on the first locator get high confidence. Steps that fall through to XPath or coordinates get low confidence and may trigger a `pause` during execution.

### Layer 3: Aegis Action API — Execution Surface

When an agent executes a verified route, it does not receive a Playwright handle or unrestricted browser context. It interacts with Aegis through an action API. The browser executes only actions that Aegis approves.

**Why agents must not have unrestricted browser control:**

- An agent with full browser control can deviate from the verified route
- A prompt-injected agent can be manipulated into performing actions outside the route scope
- Sensitive steps must be intercepted and checked against the collar before execution
- The audit trail requires Aegis to observe every step at the boundary — not reconstruct it after the fact

**How the action API works:**

The agent requests one action at a time. Aegis checks each request against:

- The current route step definition (does the requested locator match the route's expected target?)
- The active collar's `allowed_actions`, `blocked_actions`, and `approval_required_actions`
- The confidence score for the target element
- The delegation scope for this session
- Any active approval gate for this step
- The risk category of the requested action

Aegis responds with `allow`, `block`, `pause`, or `escalate`. The browser executes the action only on `allow`.

**Action API Request:**

```json
{
  "agent_id": "agent_openclaw_123",
  "session_id": "sess_abc",
  "route_id": "route_target_return_order_v1",
  "requested_action": {
    "type": "click",
    "step_id": "start_return",
    "target_locator": {
      "type": "role",
      "role": "button",
      "name": "Start a return"
    }
  }
}
```

**Aegis Response — Allow:**

```json
{
  "decision": "allow",
  "reason": "Action matches verified route and is within Collar permissions.",
  "audit_event_id": "audit_evt_123"
}
```

**Aegis Response — Block:**

```json
{
  "decision": "pause",
  "reason": "Requested action appears to initiate money movement and is outside the verified route.",
  "requires_user_approval": true
}
```

**Future action API endpoints (planned):**

```
POST /api/action/request   — Agent submits a requested action; Aegis returns allow/block/pause/escalate
POST /api/action/approve   — User approves a paused action from the approval inbox
POST /api/action/deny      — User denies a paused action
GET  /api/action/:id       — Get status of a specific action request
```

## Route Step Format

Route steps use structured locator objects — not raw CSS strings or XPath as the primary key.

**RouteLocator type:**

```typescript
interface RouteLocator {
  type: 'role' | 'label' | 'placeholder' | 'testid' | 'css' | 'xpath' | 'coordinates';
  role?: string;        // For type: 'role'
  name?: string;        // For type: 'role' or 'label' — the accessible name
  value?: string;       // For type: 'placeholder', 'testid', 'css', 'xpath'
  x?: number;           // For type: 'coordinates' — emergency fallback only
  y?: number;
}
```

**ElementTarget (updated):**

```typescript
interface ElementTarget {
  preferred_locator: RouteLocator;
  fallback_locators: RouteLocator[];   // In priority order; compiler tries each in sequence
  confidence: number;                  // 0–1: compiler's confidence in this target
  frame_path?: string[];               // Non-empty if element is inside an iframe
  shadow_root_warning?: boolean;       // True if the field resolver hit a shadow DOM boundary
}
```

**Full route step example:**

```json
{
  "action": "fill",
  "intent": "enter_search_query",
  "target": {
    "preferred_locator": {
      "type": "label",
      "name": "Search"
    },
    "fallback_locators": [
      {
        "type": "placeholder",
        "value": "Search products"
      },
      {
        "type": "role",
        "role": "textbox",
        "name": "Search"
      },
      {
        "type": "css",
        "value": "input[name='q']"
      }
    ],
    "confidence": 0.92
  },
  "value_policy": {
    "type": "runtime_variable",
    "name": "search_query",
    "store_value": false
  }
}
```

## Value Policies

Routes must never store raw sensitive values typed during recording.

Every input interaction has a value policy. The policy is determined at compile time — not at recording time. The recorder captures what the user typed; the compiler classifies whether to store, redact, or require runtime supply.

**Value policy types:**

| Policy type | Meaning |
|---|---|
| `runtime_variable` | The agent supplies the value at execution time. Store the variable name, not the value. |
| `sensitive_redacted` | A sensitive value was typed during recording. The value is not stored. The agent must request it through the Aegis credential system at runtime. |
| `safe_literal` | The value is safe to store verbatim (e.g., a product category or fixed search term in a demo workflow). |
| `enum_selection` | The field is a dropdown, radio, or segmented control. The selected option label is stored. |
| `user_approval_required` | The value must be confirmed by the user before execution, regardless of sensitivity. |

**Fields that always produce `sensitive_redacted` or `runtime_variable`:**

- `input[type=password]`
- `autocomplete` values: `cc-number`, `cc-csc`, `cc-exp`, `cc-exp-month`, `cc-exp-year`
- `input[type=email]` — `runtime_variable` by default unless the workflow is explicitly non-identity
- Fields resolving to labels or placeholders containing: "password", "card number", "CVV", "security code", "SSN", "social security", "passport"
- Any field inside a form with payment or identity signals (presence of `cc-number` or `new-password` autocomplete siblings)

**ValuePolicy type:**

```typescript
interface ValuePolicy {
  type: 'runtime_variable' | 'sensitive_redacted' | 'safe_literal' | 'enum_selection' | 'user_approval_required';
  name?: string;         // Variable name for runtime_variable
  value?: string;        // Stored value for safe_literal or enum_selection
  store_value: boolean;  // Always false for sensitive_redacted and runtime_variable
}
```

## Integration with Existing Components

| Component | Role in Rails |
|---|---|
| Browser extension | Teaching surface — records semantic telemetry during human demonstration |
| Playwright | Verification surface — replays and regression-tests routes; assigns confidence scores |
| Aegis action API | Execution surface — mediates all agent actions against route + collar |
| Collar | Permission boundary — action API checks collar on every step; collar always wins |
| Aegis Guard | Enforcement umbrella — SensitiveActionDetector, PolicyService, and ApprovalService all apply during route execution |
| ApprovalService | Handles route-defined approval gates and out-of-route sensitive action blocks |
| ReceiptService | Logs each action API call and its outcome |
| Route registry | Stores compiled routes; serves them to agents on query |
| AegisID | Identifies route creators; required for `business_official` tier verification |

## Recording Priority Summary

| Priority | Locator type | Store as |
|---|---|---|
| 1 | Accessibility role + accessible name | `{ type: 'role', role: '...', name: '...' }` |
| 2 | label[for], parent label, aria-label, aria-labelledby | `{ type: 'label', name: '...' }` |
| 3 | placeholder | `{ type: 'placeholder', value: '...' }` |
| 4 | data-testid, data-cy, data-qa | `{ type: 'testid', value: '...' }` |
| 5 | Stable CSS selector (ID or data attribute) | `{ type: 'css', value: '...' }` |
| 6 | XPath — fallback only | `{ type: 'xpath', value: '...' }` |
| 7 | Coordinates — emergency fallback, not preferred | `{ type: 'coordinates', x: ..., y: ... }` |

## Security Constraints

- Agents receive no Playwright handle, browser context reference, or CDP connection
- All agent actions during route execution go through the action API
- The action API validates route match + collar permissions + confidence threshold on every call
- Approval gates in the route definition block the action API until the user approves via the approval inbox
- Routes cannot contain executable code — validated at compile time and enforced at execution time
- Value policies prevent sensitive values from being stored in compiled routes
- The field resolver must flag shadow DOM and cross-origin iframe boundaries in the compiled route
- Low-confidence steps (`confidence < threshold`) halt execution rather than guess

## Near-Term Implementation Order

When implementing the Rails semantic recorder prototype:

1. **Update `AegisRoute` types** — Replace `ElementTarget` string selectors with `RouteLocator` objects. Add `ValuePolicy`. Add `ValuePolicy` to `RouteStep`.
2. **Build the field resolver** — A utility function that takes a DOM element reference and returns an ordered list of `RouteLocator` candidates.
3. **Build the web-based demo recorder** — A page or modal that simulates extension recording by accepting a paste of browser telemetry. (The real extension comes later; this unblocks backend and route compilation work.)
4. **Update the route compiler** — Accept semantic event payloads. Output `RouteStep[]` with `RouteLocator` targets and `ValuePolicy` per step.
5. **Add the action API skeleton** — `POST /api/action/request` stub that validates route + collar. No real browser execution yet.
6. **Playwright verification job** — A service that replays a compiled route in a sandbox and updates confidence scores.
