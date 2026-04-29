# AEGIS_RAILS.md

## What Aegis Rails Are

Aegis Rails are verified workflow routes that agents can discover and follow when navigating complex or sensitive web tasks.

An agent improvising inside a sensitive workflow — a bank transfer, a medical portal, a government form — is dangerous, error-prone, and creates liability ambiguity. When a verified route exists, the agent should not need to improvise.

Aegis Rails are the answer to: "How does a trusted agent navigate a website it has never seen?"

The answer is not better prompting. The answer is a verified route.

## Rails Architecture — Three Layers

Aegis Rails is implemented across three distinct surfaces. Mixing them is a design error.

| Layer | Surface | Role |
|---|---|---|
| 1 | Browser extension | **Teaching** — humans demonstrate workflows here |
| 2 | Playwright | **Verification** — automated replay and regression testing |
| 3 | Aegis action API | **Execution** — agents request actions; Aegis decides allow/block/pause |

The browser extension is the teaching surface. Playwright is the verification and regression-testing surface. The Aegis action API mediates all agent actions during route execution — agents never receive unrestricted browser control.

See `docs/RAILS_ARCHITECTURE.md` for the full implementation architecture: field resolver spec, Playwright-style locator format, value policies, action API request/response format, and security constraints.

## What a Route Is

A route is a structured, inspectable, permission-scoped, versioned, reviewed, and enforceable execution path for a specific workflow on a specific domain.

A route is **not**:
- A markdown file describing steps in English
- An arbitrary JavaScript file that runs inside a user's account
- A screenshot sequence
- A prompt template
- An LLM few-shot example

A route **is**:
- A declarative object that can be read, reviewed, diffed, and blocked
- Tied to a specific domain and workflow name
- Version-controlled
- Associated with a creator AegisID and verification status
- Enforceable by Aegis Guard during execution

## Route Lifecycle

### 1. Teach

A human user (or verified creator) demonstrates a workflow once in their browser. They click "Start Recording" in the Aegis interface.

### 2. Record

Aegis captures semantic browser telemetry during the demonstration. Preferred data sources, in order:

1. **Accessibility tree** — element roles, labels, names, states (primary)
2. **DOM metadata** — element IDs, classes, data attributes, form structure
3. **Browser events** — click targets, input events, navigation events, form submissions
4. **Network events** — key XHR/fetch calls, download events, redirect patterns
5. **Screenshots** — optional fallback or preview only; never the primary representation

Screenshots are expensive in tokens, fragile to UI changes, and slow to compare. Prefer structured data.

### 3. Compile

Aegis processes the recording into a declarative route object. The compiler:

- Identifies the ordered workflow steps
- Extracts element targets with primary and fallback selectors
- Classifies actions (navigate, click, type, select, submit, read, verify, wait)
- Identifies required permissions (what collar must allow)
- Identifies approval gates (which steps require human confirmation)
- Identifies forbidden sibling actions (what this route never does)
- Sets pause conditions and success conditions
- Assigns a confidence threshold for element matching

### 4. Verify

Verification is a trust tier designation. It can be automated, manual, or both.

Trust tiers (ascending):
1. **Unverified draft** — recorded but not reviewed
2. **Community** — shared publicly by a user, not reviewed by Aegis
3. **Aegis scanned** — passed automated checks (no malicious selectors, no credential-stealing patterns, no excessive permission requests)
4. **Aegis reviewed** — reviewed by a human at Aegis, route steps confirmed safe
5. **Run verified** — has a clean run history (success rate, incident rate)
6. **Business official** — published by the verified business that owns the domain

Lower-trust routes should require more explicit user consent before an agent can use them.

### 5. Publish or Save Privately

The route creator can:
- Keep the route private (stored locally, usable only by that user's agents)
- Share within a team or organization
- Publish to the Aegis route registry (public marketplace)

Private routes should be the default for sensitive personal workflows.

### 6. Discover

An agent that reaches a complex or sensitive task can query the Aegis registry:

```
POST /api/routes/query
{
  "domain": "example-bank.com",
  "intent": "transfer funds to external account",
  "required_permissions": ["payment", "account_setting_change"],
  "risk_tolerance": "low",
  "agent_aegis_id": "agt_...",
  "min_trust_tier": "aegis_reviewed"
}
```

Aegis responds with:
- Recommended route (or null if none matches)
- Trust tier
- Verified status
- Required permissions
- Approval gates
- Allowed actions
- Blocked actions
- Success rate (if available)
- Last verified date

### 7. Execute with Guardrails

During execution, Aegis Guard enforces the route:

- Actions are checked against the route's `allowed_actions` and `forbidden_actions`
- Approval gates trigger the existing approval inbox flow
- Pause conditions halt execution and surface the state to the user
- Element matching uses the stored selectors with fallback and confidence scoring
- If confidence falls below threshold, Aegis pauses and requests user guidance
- All deviations from the route are flagged and recorded

### 8. Audit

Receipts are created for each route execution:
- Which route was used (route ID, version)
- Which steps were completed
- Which gates were approved
- Which actions were blocked
- Confidence scores for element matching
- Whether the success condition was met
- Any incidents or deviations

## Route Schema

```typescript
interface AegisRoute {
  // Identity
  route_id: string;              // Unique identifier
  version: string;               // Semver e.g. "1.2.0"
  created_at: string;            // ISO timestamp
  last_verified_at: string;      // ISO timestamp

  // Origin
  creator_aegis_id: string;      // Who created this route
  trust_tier: RouteTrustTier;    // Unverified | Community | Aegis scanned | Aegis reviewed | Run verified | Business official

  // Scope
  domain: string;                // e.g. "bank.com" or "*.bank.com"
  workflow_name: string;         // e.g. "Transfer funds to external account"
  workflow_description: string;  // Human-readable description

  // Permissions
  required_permissions: ActionType[];  // What collar must allow
  allowed_actions: ActionType[];       // What this route does
  forbidden_actions: ActionType[];     // What this route never does (explicit)

  // Execution control
  approval_gates: ApprovalGate[];      // Steps that require human approval
  pause_conditions: PauseCondition[];  // Conditions that halt execution
  success_conditions: SuccessCondition[]; // How to detect route completion
  confidence_threshold: number;        // 0–1, below this Aegis pauses

  // Steps
  steps: RouteStep[];

  // History
  run_count: number;
  success_rate: number;          // 0–1
  incident_count: number;
  known_failure_points: string[];
}

interface RouteStep {
  step_id: string;
  order: number;
  action: StepActionType;        // navigate | click | type | select | submit | read | verify | wait
  intent: string;                // Human-readable intent label (e.g. "enter_search_query")
  description: string;           // Human-readable step description
  target: ElementTarget;
  value_policy?: ValuePolicy;    // How to handle the value for type/select actions
  approval_required: boolean;
  confidence_required: number;   // Step-level override
}

// Structured locator — preferred over raw CSS strings or XPath.
// Priority order: role > label > placeholder > testid > css > xpath > coordinates.
interface RouteLocator {
  type: 'role' | 'label' | 'placeholder' | 'testid' | 'css' | 'xpath' | 'coordinates';
  role?: string;    // For type: 'role'
  name?: string;    // For type: 'role' or 'label' — the accessible name
  value?: string;   // For type: 'placeholder', 'testid', 'css', 'xpath'
  x?: number;       // For type: 'coordinates' — emergency fallback only
  y?: number;
}

interface ElementTarget {
  preferred_locator: RouteLocator;
  fallback_locators: RouteLocator[];   // In priority order
  confidence: number;                  // 0–1, compiler confidence in this target
  frame_path?: string[];               // Non-empty if element is inside an iframe
  shadow_root_warning?: boolean;       // True if field resolver hit a shadow DOM boundary
}

// Routes must never store raw sensitive values typed during recording.
// The policy is determined at compile time by the route compiler.
interface ValuePolicy {
  type: 'runtime_variable' | 'sensitive_redacted' | 'safe_literal' | 'enum_selection' | 'user_approval_required';
  name?: string;        // Variable name for runtime_variable
  value?: string;       // Stored value for safe_literal or enum_selection only
  store_value: boolean; // Always false for sensitive_redacted and runtime_variable
}

interface ApprovalGate {
  step_id: string;               // The step that requires approval
  reason: string;                // Why this gate exists
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  approval_context: string;      // What to show the user in the approval card
}

type RouteTrustTier =
  | 'unverified_draft'
  | 'community'
  | 'aegis_scanned'
  | 'aegis_reviewed'
  | 'run_verified'
  | 'business_official';
```

## Route Registry API (Planned)

```
GET    /api/routes              — List routes (filterable by domain, trust_tier, workflow_name)
POST   /api/routes              — Create/publish a route
GET    /api/routes/:route_id    — Get a specific route
PUT    /api/routes/:route_id    — Update a route (creates new version)
DELETE /api/routes/:route_id    — Remove a route

POST   /api/routes/query        — Agent runtime query (returns best matching route)
POST   /api/routes/record       — Submit a new recording for compilation
GET    /api/routes/:id/runs     — Run history for a route
POST   /api/routes/:id/incident — Report an incident during route execution
```

## Route Preview Layer

Before an agent uses a route, the user should be able to inspect it. The preview must show:

- What the route does (workflow description)
- What it never does (forbidden_actions list)
- What permissions it needs (required_permissions)
- Which steps require approval (approval_gates)
- Who created it and when (creator_aegis_id, created_at)
- Trust tier and verification status
- Success rate and known failure points (if run_verified or above)
- Version history

Users should never install or run a route blindly. This is especially important for marketplace routes from unknown creators.

## Security Requirements for Routes

- **Declarative only.** Routes cannot contain executable code. No JavaScript, no shell commands, no eval.
- **Immutable once published.** A published route version cannot be edited. Only a new version can be created.
- **Aegis scans all community routes.** Before a route appears publicly, automated checks must pass: selector safety, permission scope reasonableness, no credential-harvesting patterns.
- **Business official routes require domain verification.** A route claiming `business_official` for `bank.com` must be submitted by the holder of a verified `bank.com` AegisID.
- **Routes cannot override collar restrictions.** If a collar blocks `payment`, a route that includes a payment step will still trigger the collar's block — the route does not bypass the collar.
- **Prompt injection detection in recording.** The recorder must detect and flag if a page tried to inject malicious instructions into the recorded workflow.
- **Confidence-gated execution.** If an element cannot be matched with sufficient confidence, Aegis must pause rather than guess.

## Integration with Existing Collar System

Aegis Rails build on top of collars, not instead of them:

- A route declares its `required_permissions` — these must be present in the active collar
- A route's `allowed_actions` are a subset of what the collar permits
- The collar's `blocked_actions` always win over a route's steps — routes cannot override user-set restrictions
- If a route step hits a collar restriction, Aegis falls back to the normal collar enforcement flow (block or approval_required)
- Route execution generates the same receipts as unguided session actions

## Why Accessibility Tree First

Screenshots:
- Waste tokens (a screenshot is ~1,000x larger than an accessibility tree excerpt)
- Are fragile (a visual redesign breaks screenshot matching)
- Expose potentially sensitive content (visible text, images)
- Are slow to compare and version

Accessibility tree + DOM metadata:
- Compact and token-efficient
- Durable across visual redesigns if ARIA labels are maintained
- Machine-readable and diffable
- Safe to store and transmit
- The same data source that screen readers use — semantically meaningful

Aegis should default to structured telemetry and use screenshots only when a workflow step requires visual verification (e.g., a CAPTCHA) or as an optional human-readable preview in the route listing.

## Relationship to Existing Components

| Existing component | Role in Rails |
|---|---|
| Protected session (Playwright) | Execution environment for route steps |
| Collar | Permission boundary that routes must respect |
| Aegis Pass | Authentication credential for the session |
| SensitiveActionDetector | Fallback when no route is active; also validates route steps |
| PolicyService | Extended to accept route context during enforcement |
| ApprovalService | Handles route approval gates |
| ReceiptService | Records route execution events |
| AegisID | Identifies route creators and verifies business-official routes |
