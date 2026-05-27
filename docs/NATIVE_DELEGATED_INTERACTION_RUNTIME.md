# Native Delegated Interaction Runtime

**Core principle:** Agents reason semantically. Antigen executes physically.

The external agent decides *what* to do — click Continue, fill email, open dropdown, proceed through checkout. Antigen decides *how* to safely execute it: target resolution, pointer movement, native input dispatch, approval gates, receipts.

This document plans the next runtime layer: a native browser interaction system that lets agents stay at the semantic level while Antigen physically executes actions through realistic, browser-native input.

---

## Why We Are Building This

### 1. Direct DOM automation is brittle

Common failure patterns:

- `element.click()` — skips focus, hover, and event propagation; fails on React controlled inputs and hover menus
- `el.value = '...'` — bypasses React's synthetic event system; forms do not register the change
- Synthetic JS events (`dispatchEvent`) — detected and ignored by many modern auth and payment flows
- Instant interactions — zero-duration fills and clicks fail on animated modals, accordion dropdowns, and multi-step checkout flows

These problems appear consistently on Auth0 login pages, Stripe-backed checkout flows, social login forms, and dropdown-gated selectors.

### 2. Fresh automation sessions look unnecessarily suspicious

Antigen does not need to defeat bot detection. But teleport-clicking (cursor jumps from 0,0 to element center) and silent DOM mutation are not representative of how users interact. Native pointer events through the existing `AEGIS_PLAYWRIGHT_CDP_URL` channel are a straightforward improvement with no deceptive intent.

### 3. Agents should not own physical browser execution

Agents should choose *what* to do. Antigen should decide *how* to safely execute it. Mixing semantic reasoning with physical execution details in the agent makes agents brittle, harder to audit, and tightly coupled to page layout.

### 4. Human verification is a real blocker

When Cloudflare Turnstile, hCaptcha, or reCAPTCHA appears mid-flow, the agent must pause and wait for a human. This is a normal part of authorized delegated browsing — not an exception. The runtime needs a first-class pause/resume path tied to the existing Challenge Relay (see `docs/` for Challenge Relay v1).

---

## What We Are Not Building

- Fingerprint spoofing or browser fingerprint modification
- Fake cookie injection or session replay from scraped profiles
- CAPTCHA bypass, hCaptcha bypass, or any human-verification bypass
- Random fake browsing history or pre-warm scripts
- Bot evasion tools of any kind
- Anything that misrepresents Antigen as a human user to security systems

The goal is **native compatibility and reliable sensitive handoffs**, not circumvention.

---

## Two Parallel Tracks

### Track A — Native Pointer Runtime v1

**Purpose:** A runtime helper that executes semantic browser actions through native pointer and input events via CDP.

**What it does:**

- Maintains persistent mouse state per browser session (`PointerRuntimeState`)
- Resolves a semantic target (element selector, role, label) to a bounding box and viewport coordinates
- Chooses a non-center click point within the element bounds
- Generates a smooth pointer path from current position to target
- Dispatches `CDP Input.dispatchMouseEvent` events: `mouseMoved` → hover pause → `mousePressed` → `mouseReleased`
- Updates persistent mouse state after each action
- Uses `CDP Input.insertText` for text entry (already in use; this integrates it into the unified pointer runtime)
- Supports configurable interaction modes: `fast`, `native`, `realistic`, `careful`

**Initial use cases:**

- Focus and fill login / profile / payment fields
- Click Continue / Next / Sign In buttons in sensitive flows
- Checkout step buttons and confirmation clicks
- Account creation and login form interactions

**Out of scope for v1:**

- User-calibrated movement trace import
- Normalized template matching (v2 algorithm)
- Cloudflare bypass or detection avoidance
- Keystroke simulation (text entry via `Input.insertText` is sufficient)
- Cross-session pointer state sharing

**Done when:**

- `PointerRuntimeState` is maintained per `browser_session_id`
- Element bounding box is resolved from a CSS selector or accessibility role
- Smooth path is generated from current pointer position to target click point
- CDP `mouseMoved` events are dispatched along the path with configurable timing
- `mousePressed` / `mouseReleased` are dispatched at the target
- Pointer state is updated after each action
- Interaction mode controls timing (see Latency Strategy)
- Integration with existing `request_secret_field_injection` path (CDP fill) for field targeting
- Unit-testable path generation (no CDP required for path math tests)

---

### Track B — Pointer Calibration Lab v1

**Purpose:** A local dev-only environment that guides a real user through natural mouse interactions and exports labeled pointer traces for future use in the v2 algorithm.

**What it does:**

Presents a calibration page with guided tasks. For each task, records pointer events and exports a labeled `PointerTrace` JSON object. Data stays local — no server upload, no external transmit.

**Guided task set:**

| # | Task | Purpose label |
|---|------|---------------|
| 1 | Click large button (120×48px) | `button_click` |
| 2 | Click small button (64×32px) | `button_click` |
| 3 | Focus text input field | `input_focus` |
| 4 | Open dropdown / select | `dropdown` |
| 5 | Horizontal move (left to right, ~400px) | `long_move` |
| 6 | Vertical move (top to bottom, ~300px) | `long_move` |
| 7 | Diagonal move to far corner | `long_move` |
| 8 | Short correction move (<60px) | `correction` |
| 9 | Drag slider to 75% | `drag` |
| 10 | Scroll panel down | `scroll` |
| 11 | Click target after scroll | `button_click` |
| 12 | Click near viewport edge | `button_click` |

**What it records per task:**

- `pointermove`, `pointerdown`, `pointerup`, `click`, `wheel` / scroll events
- Timestamps using `performance.now()` for sub-millisecond resolution
- Target element bounding box at time of interaction
- Viewport dimensions at time of interaction
- Task purpose label

**Controls:**

- Restart current task
- Skip task
- Export all completed traces as JSON
- Copy JSON to clipboard

**Out of scope for Track B:**

- Playwright / CDP integration
- Runtime execution of any kind
- Keystroke collection
- Collecting sensitive values (no form inputs with real data)
- Server upload or remote storage
- Bot evasion framing

**Done when:**

- Calibration page renders at a local dev route (e.g. `/calibration-lab`)
- All 12 guided tasks are present with visual instruction and target elements
- Pointer events are recorded with timestamps and bounding boxes
- Each completed task produces a valid `PointerTrace` object
- Export as JSON and copy-to-clipboard work
- No network requests are made during or after calibration
- Output JSON validates against the `PointerTrace` schema below

---

## Shared Data Model

These types are shared between Track A (runtime) and Track B (calibration output).

**`PointerTracePoint`**

```
x           number   — absolute viewport x
y           number   — absolute viewport y
t_ms        number   — milliseconds since trace start (performance.now() delta)
event?      string   — "move" | "down" | "up" | "click" | "scroll"
```

**`PointerTrace`**

```
trace_id        string   — UUID
purpose         string   — "button_click" | "input_focus" | "dropdown" | "drag" | "scroll" | "correction" | "long_move"
start           { x, y } — pointer position at trace start
end             { x, y } — pointer position at trace end
target_box      { x, y, width, height } — bounding box of target element
viewport        { width, height }
duration_ms     number
distance_px     number   — straight-line distance start → end
direction_rad   number   — angle of start → end vector
points          PointerTracePoint[]
```

**`PointerRuntimeState`**

```
browser_session_id   string
current_x            number
current_y            number
viewport_width       number
viewport_height      number
last_action_at       ISO8601 timestamp
interaction_mode     "fast" | "native" | "realistic" | "careful"
```

---

## V2 Algorithm Plan

This section describes the intended v2 movement algorithm. Do not implement in v1.

### Why NOT precompute absolute paths

A naive approach would record full coordinate-to-coordinate paths and replay them. This does not generalize:

- Viewport sizes change (desktop vs. laptop vs. resized window)
- Scroll state moves elements; recorded absolute Y is wrong after scroll
- Responsive layouts reflow elements between sessions
- Modals and overlays shift target positions
- Path math is cheap; browser round trips and intentional movement time dominate latency

**Instead:** store normalized human movement primitives and transform them onto the current target at runtime.

### Algorithm

**Step 1 — Record.** Calibration Lab (Track B) produces labeled `PointerTrace` objects.

**Step 2 — Normalize.** For each trace:
- Translate so `start` becomes `(0, 0)`
- Rotate so `end` becomes `(1, 0)` (the target is always "to the right" in normalized space)
- `x` = progress toward target; `y` = perpendicular deviation
- Preserve timing and velocity curve (t_ms values stay relative)

**Step 3 — Index templates** by:
- Distance bucket (e.g. <100px, 100–300px, 300–600px, 600px+)
- Direction bucket (8 octants or 16 sectors)
- Target type (button, input, dropdown, drag handle)
- Movement purpose (`button_click`, `input_focus`, etc.)
- Duration / speed profile

**Step 4 — At runtime:**
1. Resolve semantic target to bounding box
2. Choose click point inside target (non-center, slight random offset)
3. Compute vector from `(current_x, current_y)` to click point
4. Select closest matching template from index (distance + direction + target type)
5. Scale and rotate the normalized template onto the current vector
6. Optionally stitch a `correction` template near the endpoint (final approach refinement)
7. Dispatch CDP `Input.dispatchMouseEvent mouseMoved` events along the generated path
8. Hover pause at endpoint
9. Dispatch `mousePressed` / `mouseReleased`
10. Update `PointerRuntimeState`

---

## Latency Strategy

Latency is acceptable when purposeful. Adding movement time to sensitive actions is a feature, not a bug — it reflects how users actually interact with consequential flows.

**Interaction modes:**

| Mode | When to use | Behavior |
|------|-------------|----------|
| `fast` | Low-risk internal navigation, simple browsing actions | Minimal movement, small delay |
| `native` | Normal browser-native click/focus on standard pages | Short smooth path, browser-native events |
| `realistic` | Login, signup, profile fields, checkout steps | Full pointer path, velocity curve, hover pause |
| `careful` | Payment confirmation, account changes, final irreversible actions | Slower movement, longer hover pause, deliberate click |

**Guidelines:**

- Do not use `realistic` or `careful` for every low-risk browsing action — reserve for sensitive boundaries
- Use `native` as the default for most agent-driven interactions
- `careful` should be coupled with collar-gated approval steps where one already exists
- Slight latency at sensitive boundaries is a trust signal when tied to risk context and collar scope

---

## Human Verification Policy

Antigen does not bypass CAPTCHA, Cloudflare Turnstile, hCaptcha, reCAPTCHA v2/v3, or any human-presence verification system.

**When a human verification challenge is encountered:**

1. Agent detects the blocker (challenge iframe, Cloudflare interstitial, etc.)
2. Agent calls `report_security_challenge` with `challenge_type: "human_verification"` (or equivalent)
3. Antigen pauses the current execution path and surfaces a blocker in the approval UI
4. User completes the challenge manually in the Antigen-controlled browser
5. Agent polls `wait_for_security_challenge` or receives a resume signal
6. Execution continues if possible; if the session expired or the page changed, agent re-evaluates
7. A receipt / audit event records: blocker encountered, resolution method (`user_manual`), timestamp

**What Antigen never does:**

- Solves CAPTCHA images
- Submits audio CAPTCHA
- Rotates IP or user agent to avoid challenges
- Uses third-party CAPTCHA solving services
- Claims challenges did not appear when they did

---

## Implementation Sequence

Both tracks can proceed in parallel. Neither blocks the other.

**Track A — Native Pointer Runtime v1**

1. Define `PointerRuntimeState` type and in-memory store keyed by `browser_session_id`
2. Implement `resolveElementBoundingBox(selector, cdpUrl)` — CDP `DOM.getBoxModel` or Playwright locator
3. Implement `chooseClickPoint(box)` — non-center point within bounds
4. Implement `generatePointerPath(from, to, mode)` — smooth interpolated path with timing
5. Implement `dispatchPointerPath(path, cdpUrl)` — CDP `Input.dispatchMouseEvent` loop
6. Implement `dispatchClick(point, cdpUrl)` — `mousePressed` / `mouseReleased`
7. Integrate with `request_secret_field_injection` for field focus before `Input.insertText`
8. Expose interaction as internal helper (not a new public MCP tool in v1)
9. Test path generation math in isolation (no CDP required)
10. Integration test against a local test page with React inputs

**Track B — Pointer Calibration Lab v1**

1. Create `/calibration-lab` route in the web app
2. Build task runner component: instruction display, target rendering, task state machine
3. Implement pointer event recorder (pointermove, pointerdown, pointerup, click, wheel)
4. Implement bounding box capture at task completion
5. Assemble `PointerTrace` object per task
6. Build export (JSON download) and copy-to-clipboard controls
7. Add restart / skip controls
8. Verify no network requests during session (Content-Security-Policy test or network log check)
9. Manually run all 12 tasks; confirm exported JSON validates against schema

---

## Future Direction

**Today:** Websites infer trust from human-like interaction patterns, session age, cookies, and browser fingerprints. Automation sessions fail because they look structurally different.

**MVP (this document):** Antigen improves reliability through persistent sessions, native pointer events, browser-native input, and human verification handoff. No deception — just using the browser as it was designed.

**Future:** Websites that adopt AegisID / signed delegation / scoped permissions / violation receipts can trust Antigen's identity directly. As this adoption grows, the need to rely on interaction-pattern signals diminishes. The pointer runtime becomes a compatibility layer for sites that have not yet adopted Antigen-native trust — not a permanent requirement.

---

## Potential IP Note

This work may be worth capturing as an invention disclosure. Possible invention themes:

- **User-calibrated native pointer execution for delegated agents** — importing real user movement traces and replaying them for authorized agent actions
- **Normalized movement trace templates transformed onto semantic browser targets** — distance/direction bucketing + scale/rotate warping for viewport-agnostic path generation
- **Risk-tiered interaction modes for sensitive agent actions** — coupling pointer realism level to collar scope and action risk classification
- **Integration of native pointer runtime with agent approval gates, collars, and signed receipts** — provenance-preserving execution that ties physical actions to authorization records

No legal claims are made here. Flag for IP review if this advances.

---

## Open Questions

1. Should `PointerRuntimeState` be stored in the existing `taskBrowserSessions` Map or a separate Map? The session ID is shared, but pointer state is distinct from browser lifecycle state.
2. What CDP method is most reliable for bounding box resolution — `DOM.getBoxModel`, `Runtime.callFunctionOn` with `getBoundingClientRect`, or Playwright's `locator.boundingBox()`? (Playwright is preferred when available; CDP fallback for raw sessions.)
3. Should Track B live in `apps/web` as a dev-only page or as a standalone local HTML file? A dev-only route in `apps/web` is simpler but adds surface area; a standalone HTML file is completely isolated.
4. In v2, how many normalized templates per bucket are useful before diminishing returns? Initial hypothesis: 5–10 traces per (distance × direction × purpose) bucket is sufficient.
5. Should `interaction_mode` be set at the task level (per `start_task_browser_session`) or per-action? Per-action is more flexible; per-task is simpler and matches how collars scope sensitivity.

---

## Done When

### Track A — Native Pointer Runtime v1

- [ ] `PointerRuntimeState` maintained per `browser_session_id`
- [ ] Element bounding box resolved from selector or role
- [ ] Smooth pointer path generated from current position to target
- [ ] CDP `mouseMoved` events dispatched with interaction-mode-appropriate timing
- [ ] `mousePressed` / `mouseReleased` dispatched at target
- [ ] Pointer state updated after each action
- [ ] Integration with `request_secret_field_injection` field targeting (focus before fill)
- [ ] Path generation is unit-testable without CDP
- [ ] Integration tested against a local React input form

### Track B — Pointer Calibration Lab v1

- [ ] All 12 guided tasks render with instructions and target elements
- [ ] Pointer events recorded with `performance.now()` timestamps and bounding boxes
- [ ] Each completed task produces a valid `PointerTrace` object
- [ ] Export JSON and copy-to-clipboard work correctly
- [ ] Restart and skip controls work
- [ ] No network requests made during or after calibration (verified)
- [ ] Exported JSON validates against `PointerTrace` schema
- [ ] Page is clearly marked as dev-only (header warning or route guard)
