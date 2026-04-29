# Aegis Rails — External Recording Plan

## Status: Planning

This document captures the architecture, risks, and first safe target for extending Aegis Rails recording from the mock bank page to outside websites via a Chrome extension.

**Scope:** Planning and analysis only. No production code changes are made by this document.

---

## Why Outside Websites Are Different from bank.html

The current recorder is embedded directly inside `apps/mock-store/bank.html` — a page Aegis owns and controls. This creates several advantages that disappear on outside websites:

| What we control on bank.html | What we lose on outside websites |
|---|---|
| The recorder panel UI lives in the page HTML | Cannot embed UI into a page we don't own |
| `fetch('/api/routes/record')` is called from the page | Page origin does not have access to localhost API |
| ARIA quality is designed to be good | Real sites have inconsistent or missing ARIA |
| DOM structure is stable and known | React/SPA hydration mutates the DOM after load |
| No iframes or Shadow DOM in the way | Both are common on real sites and block content scripts |
| Sensitive field patterns are fully known | Must detect conservatively on unknown forms |

A Chrome extension content script solves the ownership problem — but it operates as a guest inside an environment it does not control.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Chrome Extension                                               │
│                                                                 │
│  ┌──────────────┐     chrome.runtime     ┌────────────────────┐│
│  │  Popup UI    │◄──────sendMessage──────►│ Background Worker  ││
│  │              │                         │                    ││
│  │ Start/Stop   │                         │ - buffers events   ││
│  │ event count  │                         │ - on Stop:         ││
│  │ domain name  │                         │   POST /api/       ││
│  └──────────────┘                         │   routes/record    ││
│                                           └────────┬───────────┘│
│  ┌──────────────────────────────────┐              │            │
│  │  Content Script (injected)       │              │            │
│  │                                  │              │            │
│  │  - resolveFieldLabel()           │──sendMessage►│            │
│  │  - inferRole()                   │              │            │
│  │  - buildLocators()               │              │            │
│  │  - isSensitiveField()            │              │            │
│  │  - captureEvent()                │              │            │
│  │  - document event listeners      │              │            │
│  └──────────────────────────────────┘              │            │
└───────────────────────────────────────────────────┬┘            │
                                                    │             │
                                    POST /api/routes/record       │
                                                    ▼             │
                              ┌─────────────────────────────────┐ │
                              │  Local Aegis API (unchanged)    │ │
                              │  apps/api — routeCompiler.ts    │ │
                              │  → AegisRoute saved to store    │ │
                              │  → appears in Recorded Skills   │ │
                              └─────────────────────────────────┘ │
```

### Three components

**Content Script** — runs in the context of the page the user is recording on. Captures `SemanticRecordingEvent` payloads using the same field resolver logic already in `bank.html`. Sends each event to the background worker. Never makes network calls directly.

**Background Service Worker** — collects events while recording is active. On Stop, assembles the `RecordingPayload` and POSTs it to the local Aegis API at `http://localhost:4000/api/routes/record`. Owns the API call so there are no mixed-content or CORS issues from page scripts.

**Popup UI** — Start / Stop controls, live event count, current domain display. Triggers the background worker. Replaces the embedded recording panel from `bank.html`.

---

## Recorder MVP Design

### User flow

1. User navigates to the target page in Chrome
2. User opens the Aegis extension popup and clicks **Start Recording**
3. Popup sends `{action: "start", domain: location.hostname}` to background worker
4. Background worker injects the content script into the active tab
5. Content script attaches event listeners to `document` (event delegation)
6. User performs the workflow normally
7. User clicks **Stop Recording** in the popup
8. Popup sends `{action: "stop"}` to background worker
9. Background worker POSTs buffered events to `/api/routes/record`
10. Route appears in the Recorded Skills workspace

### Content script behavior

- Attach listeners to `document` for `click`, `change`, and `blur` on input elements
- On each event: call `captureEvent(element, eventType)` — same logic as `bank.html` lines 599–637
- Filter: only capture elements with a semantic role (form controls, links, buttons)
- Send each `SemanticRecordingEvent` to background via `chrome.runtime.sendMessage`
- Listen for `pushState` / `popstate` to capture SPA navigations as `navigate` events

---

## Required Chrome Extension Permissions

```json
{
  "permissions": [
    "activeTab",
    "scripting",
    "storage"
  ],
  "host_permissions": [
    "http://localhost:4000/*"
  ]
}
```

| Permission | Why |
|---|---|
| `activeTab` | Access the DOM of the current tab when the user clicks Start — no broad host access |
| `scripting` | Inject the content script dynamically into the active tab |
| `storage` | Persist recording session state (active/stopped, buffered events) across popup open/close |
| `host_permissions: localhost:4000` | Background worker must reach the local Aegis API |

**Not needed for MVP:** `tabs`, `webRequest`, `declarativeNetRequest`, broad `<all_urls>` host permissions.

---

## Event Capture Strategy

### Listener attachment

Attach all listeners to `document` using event delegation rather than individual elements. This survives React/SPA DOM mutations that replace the entire subtree after hydration.

```js
document.addEventListener('click', handleClick, true);
document.addEventListener('change', handleChange, true);
document.addEventListener('blur', handleBlur, true);
```

Use capture phase (`true`) to intercept events before the page's own handlers can call `stopPropagation`.

### SPA navigation

Intercept `history.pushState` and `history.replaceState` by wrapping the native methods, and listen for `popstate`. Emit a `navigate` event when the URL changes.

### What is captured per event

- `type`: `click` | `fill` | `select` | `navigate` | `submit`
- Element metadata: `element_type`, `element_role`, `input_type`, `aria_label`, `placeholder`, `input_name`, `input_id`
- `label_text`: resolved via `resolveFieldLabel()` priority chain
- `visible_text`: button/link text content
- `nearby_text`: nearest heading or fieldset legend
- `options`: captured `<option>` labels for `<select>` elements
- `raw_value`: text input value — **stripped to `null` for sensitive fields before leaving the content script**
- `locators`: array of `RouteLocator` objects built by `buildLocators()`

### What is NOT captured

- Keystrokes — no `keypress` or `keydown` listeners
- Raw values for sensitive fields (see Sensitive Value Redaction)
- Full page screenshots
- Raw HTML or `innerHTML`
- Network request bodies
- Cookies or storage contents

---

## Field Resolver Strategy

The field resolver in `bank.html` (lines 494–586) is pure DOM JavaScript with no page-specific dependencies. It can be ported verbatim into the content script.

### Priority chain for `resolveFieldLabel(element)`

1. `element.getAttribute('aria-label')` — highest confidence
2. `label[for=element.id]` text content
3. `element.getAttribute('placeholder')`
4. Nearest `<label>` ancestor text
5. Nearest heading (`h1`–`h6`) or `<legend>` text

### Priority chain for `buildLocators(element)`

Produces a `RouteLocator[]` in priority order:

| Priority | Locator type | Confidence |
|---|---|---|
| 1 | `role` — ARIA role + accessible name | 0.90 |
| 2 | `label` — resolved label text | 0.88 |
| 3 | `placeholder` — input placeholder | 0.82 |
| 4 | `testid` — `data-testid` or `data-aegis` attribute | 0.85 |
| 5 | `css` — name or id attribute selector | 0.70 |
| 6 | `xpath` — fallback only | 0.50 |
| 7 | `coordinates` — pixel position, last resort | 0.30 |

The `routeCompiler.ts` server already handles the full locator array and deduplicates by `type+value+role` — no changes needed.

### Shadow DOM flag

If the element is detected to be inside a Shadow DOM boundary (check via `element.getRootNode() instanceof ShadowRoot`), set `shadow_root_warning: true` on the `ElementTarget`. The route will compile but the step will carry a lower confidence score.

---

## Sensitive Value Redaction

Redaction happens **in the content script, before any IPC**. No sensitive value ever reaches the background worker or the API.

### Fields that always produce `sensitive_redacted`

- `input[type=password]`
- Any field with `autocomplete` matching: `cc-number`, `cc-csc`, `cc-exp`, `cc-exp-month`, `cc-exp-year`, `cc-name`
- Any field whose resolved label matches (case-insensitive): `password`, `card number`, `cvv`, `cvc`, `ssn`, `social security`, `passport`, `account number`, `pin`

### Fields that produce `runtime_variable`

- `input[type=email]`
- Any field whose resolved label matches: `email`, `phone`, `username`, `date of birth`

### Result for sensitive fields

```js
{
  raw_value: null,          // never captured
  value_policy: {
    type: 'sensitive_redacted',
    store_value: false
  }
}
```

The content script must apply `isSensitiveField(element)` (from `bank.html` lines 588–597) **before** reading `element.value`. If sensitive, skip the value entirely.

### Conservative default

When uncertain, default to `sensitive_redacted`. A `runtime_variable` that turns out to be safe can be downgraded later; a stored sensitive value cannot be un-stored.

---

## Iframe and Shadow DOM Limitations

### Cross-origin iframes

`activeTab` does not grant access to cross-origin iframe content. The content script cannot attach listeners inside a `<iframe src="https://stripe.com/...">` or similar.

**MVP behavior:** Detect iframe boundaries. If the user clicks inside a cross-origin iframe, the content script will see the click on the `<iframe>` element itself but not the element inside it. Log a `recording_gap` event with `reason: "cross_origin_iframe"` and surface a warning badge in the popup ("Recording paused — cross-origin frame detected").

Same-origin iframes can be handled by injecting the content script into the iframe's document separately.

### Shadow DOM

Elements inside a closed Shadow DOM root are opaque to `querySelector`. `resolveFieldLabel()` and `buildLocators()` will fail to find labels or ARIA attributes that live inside the shadow root.

**MVP behavior:** If `element.getRootNode() instanceof ShadowRoot`, attempt best-effort capture with what is accessible, set `shadow_root_warning: true`, and accept lower confidence. Do not attempt to pierce shadow roots.

### Dynamic React / SPA pages

Event delegation on `document` survives most React re-renders. The risk is that React replaces element references, making post-capture locator re-validation harder. Mitigate by capturing locators at event time (not deferred) and including enough fallback locators that at least one survives a re-render.

---

## First Safe External Target

### Recommendation: Wikipedia search

**URL:** `https://en.wikipedia.org`

**Why Wikipedia:**
- No authentication required
- No personally identifiable information involved
- Stable, well-known DOM structure (`input#searchInput`, `button[type=submit]`)
- Proper ARIA labels (`aria-label="Search Wikipedia"`)
- WCAG 2.1 AA compliant — one of the best-labeled public sites
- No iframes or Shadow DOM in the search critical path
- Simple 3-step workflow: focus search box → type query → submit
- Low risk of accidental sensitive data capture
- Publicly documented DOM — easy to verify locators by hand

**Expected compiled route:**
```
steps:
  1. fill — input[role=searchbox] — label:"Search Wikipedia" — value_policy: safe_literal
  2. click — button[type=submit] — visible_text:"Search" — value_policy: null
navigate:
  - https://en.wikipedia.org/wiki/...
risk_level: low
approval_gates: []
```

**Second-choice:** GitHub public repository search at `https://github.com/search` — also no PII, stable DOM, no payment flows.

### What to avoid for the first test

| Target | Why to skip |
|---|---|
| Gmail | Authentication required; message content is sensitive |
| LinkedIn | Authentication required; professional PII |
| Any bank | Financial credentials; payment flows |
| Checkout flows | Payment card fields; purchase actions |
| Messaging apps | Message content is sensitive data |
| Medical / legal portals | PII; regulated data |
| Any site requiring login | Credentials are sensitive |

---

## Explicit Non-Goals for Extension MVP

- No Manifest V3 side panel — popup is sufficient
- No cross-origin iframe injection
- No Shadow DOM piercing
- No replay or playback inside the extension
- No remote API — all routes go to local Aegis API only (`localhost:4000`)
- No publishing routes to a shared registry
- No agent execution
- No targeting any auth-gated, payment, messaging, or sensitive portal workflow
- No changes to `/demo`, `apps/api`, `apps/web`, or any existing Aegis service

---

## Technical Risks and Safeguards

| Risk | Safeguard |
|---|---|
| **SPA navigation breaks listener attachment** | Use event delegation on `document`; wrap `history.pushState` to emit `navigate` events |
| **React re-render replaces captured elements** | Capture locators at event time; include enough fallbacks that re-identification works |
| **Prompt injection via page content** | Never pass raw `innerHTML`, page text, or `textContent` to the API; only structured metadata (role, label, placeholder) |
| **Mixed-content block on HTTPS pages** | Background service worker calls the API — no call from page context; no mixed-content issue |
| **Poor ARIA on real sites** | Fallback locator chain handles missing ARIA; confidence scores lower, but `routeCompiler.ts` already handles this |
| **Accidental sensitive capture** | `isSensitiveField()` is conservative; uncertain fields default to `sensitive_redacted`; raw value never transmitted for sensitive fields |
| **Permission scope creep** | Use `activeTab` not broad `<all_urls>`; no `webRequest`; host permission scoped to localhost only |
| **Recording inside login / auth pages** | Do not target auth flows in MVP; if a password field is encountered during any recording, `isSensitiveField` silently redacts it |
| **Extension XSS via page DOM** | Content script reads only element attributes and computed labels — never `innerHTML`; no `eval`, no dynamic script injection |

---

## Implementation Milestones

| Milestone | Description | Production code changes |
|---|---|---|
| **M0** (this doc) | Architecture plan, risk analysis, first target identified | None |
| **M1** | Chrome extension scaffold: `manifest.json`, popup HTML/JS, background service worker skeleton, content script skeleton (no API calls yet) | New: `apps/extension/` directory |
| **M2** | Content script event capture: port `resolveFieldLabel`, `inferRole`, `buildLocators`, `isSensitiveField`, `captureEvent` from `bank.html`; test on Wikipedia manually | New files in `apps/extension/` only |
| **M3** | Background worker + API integration: assemble `RecordingPayload`, POST to `/api/routes/record`, confirm route appears in Recorded Skills workspace | New files in `apps/extension/` only |
| **M4** | End-to-end test on Wikipedia search: record → compile → inspect route JSON → verify steps, value policies, confidence scores | None |

### Files affected per milestone

- M1–M4: New directory `apps/extension/` only
- `apps/api/src/`: no changes
- `apps/web/src/`: no changes
- `apps/mock-store/bank.html`: no changes
- `packages/types/src/index.ts`: no changes (existing `SemanticRecordingEvent` and `RecordingPayload` types already cover the extension's output format)

---

## References

- `docs/AEGIS_RAILS.md` — product specification for Aegis Rails
- `docs/RAILS_ARCHITECTURE.md` — full technical architecture including field resolver spec, locator format, value policies, and action API design
- `apps/mock-store/bank.html` lines 494–672 — recorder functions to port to the content script
- `apps/api/src/services/routeCompiler.ts` — server-side compilation (unchanged)
- `packages/types/src/index.ts` lines 445–464 — `SemanticRecordingEvent` interface (the contract the extension must produce)
