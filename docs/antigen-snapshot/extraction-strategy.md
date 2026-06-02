# Antigen Snapshot — Extraction Strategy

This document defines how Antigen queries the live page to build its element list. The goal is a deterministic, privacy-safe, metadata-only extraction that captures visible interactive elements without reading field values or dumping the full DOM.

---

## Execution Method

Antigen sends a JS IIFE (immediately-invoked function expression) to the browser via `CDP Runtime.evaluate` (or the Playwright equivalent `page.evaluate`). The IIFE runs inside the page context and returns a JSON-serializable array of element descriptors.

Key constraints:
- The callback must be a **raw JS string IIFE**, not a TypeScript/Node arrow function, because the page runtime is a browser context without the Node.js DOM lib.
- Keep the IIFE small and self-contained; do not import modules or reference closures from Node.js.
- Return only serializable data (no DOM node references).

```javascript
// Sent via CDP Runtime.evaluate
const result = await page.evaluate(`(function extractElements(opts) {
  // ... extraction logic ...
  return elements;
})({ viewportOnly: true, maxElements: 200 })`);
```

---

## Candidate Selector List

The extractor queries these selectors to find interactive element candidates. This list covers standard semantic HTML and ARIA roles:

```
a[href],
button,
input,
textarea,
select,
details > summary,
[role="button"],
[role="link"],
[role="menuitem"],
[role="option"],
[role="tab"],
[role="checkbox"],
[role="radio"],
[role="switch"],
[role="combobox"],
[role="searchbox"],
[role="textbox"],
[tabindex]:not([tabindex="-1"]),
[contenteditable="true"]
```

- `tabindex="-1"` elements are excluded because they are not keyboard-navigable and are typically decorative or programmatically managed.
- `details > summary` captures disclosure widgets that open/close sections.
- The list is a starting set. Future versions may add site-specific annotations.

---

## Visibility Filter

An element passes the visibility filter only if all conditions hold:

1. `getBoundingClientRect().width > 0 && height > 0` — must have a renderable box
2. `getComputedStyle(el).display !== "none"` — not hidden by display
3. `getComputedStyle(el).visibility !== "hidden"` — not hidden by visibility
4. `getComputedStyle(el).opacity !== "0"` — not fully transparent
5. Not `aria-hidden="true"` (unless the element itself is focusable and user-actionable — rare edge case)
6. `viewport_only` option (default true): `getBoundingClientRect().top < window.innerHeight && getBoundingClientRect().bottom > 0 && getBoundingClientRect().left < window.innerWidth && getBoundingClientRect().right > 0`

Elements failing any condition are excluded from the candidate list. They do not appear in the snapshot at all — the agent cannot choose what it cannot see.

---

## Enablement Filter

An element is marked `enabled: false` (and penalized heavily in scoring) if any of:

1. `el.disabled === true` — native disabled attribute
2. `el.getAttribute("aria-disabled") === "true"` — ARIA disabled
3. `el.closest("[inert]") !== null` — inside an inert subtree
4. For typeable controls: `el.readOnly === true` means the element exists but cannot accept typed input (mark as `enabled: false` for `browser_type`, `enabled: true` for `browser_click` if clicking is meaningful)
5. `getComputedStyle(el).pointerEvents === "none"` — not clickable via pointer

Disabled elements are not filtered out of the snapshot entirely. They appear with `state.enabled: false`. The agent should not click them; Antigen will reject such attempts at resolution time.

---

## Name Extraction Order

For each element, extract the accessible name using this priority order:

1. `aria-label` attribute (direct)
2. `aria-labelledby` → resolve referenced elements → join their `textContent`
3. Associated `<label>` element text (via `for=` attribute or wrapping label)
4. `alt` text of an `<img>` inside the element
5. `title` attribute
6. `innerText` (trimmed, normalized whitespace)
7. `textContent` fallback (if `innerText` is empty)
8. `placeholder` attribute (for inputs only, if all above are empty)
9. `value` attribute — **only for non-sensitive controls** (e.g., submit buttons where `value` is the label); never for `type="password"`, `type="hidden"`, or payment/credential fields

Never read `.value` for:
- `input[type="password"]`
- Fields with `autocomplete` values in: `cc-number`, `cc-csc`, `cc-exp`, `cc-exp-month`, `cc-exp-year`, `cc-name`, `cc-type`
- Fields with `id`/`name`/`autocomplete` containing: `ssn`, `social`, `passport`, `routing`, `account-number`
- Any field inside a credential or payment form context

If no name can be extracted, use an empty string. These elements appear in the snapshot but score poorly for natural-language targeting.

---

## Kind Inference

| Input condition | `kind` | `role` |
|-----------------|--------|--------|
| `input[type="search"]` | `input` | `searchbox` |
| `input[type="text"]`, `input[type="email"]`, `input[type="tel"]`, `input[type="url"]`, `input[type="number"]` | `input` | `textbox` |
| `input[type="password"]` | `input` | `textbox` (mark as credential_field in sensitivity) |
| `input[type="checkbox"]` | `control` | `checkbox` |
| `input[type="radio"]` | `control` | `radio` |
| `input[type="submit"]`, `input[type="button"]`, `input[type="reset"]` | `button` | `button` |
| `button` | `button` | `button` |
| `[role="button"]` | `button` | `button` |
| `a[href]` | `link` | `link` |
| `[role="link"]` | `link` | `link` |
| `select` | `select` | `combobox` |
| `textarea` | `text_area` | `textbox` |
| `[contenteditable="true"]` | `editor` | `textbox` |
| `details > summary` | `summary` | `button` |
| `[role="menuitem"]` | `button` | `menuitem` |
| `[role="option"]` | `control` | `option` |
| `[role="tab"]` | `button` | `tab` |
| `[role="switch"]` | `control` | `switch` |
| `[role="combobox"]` | `select` | `combobox` |
| `[role="searchbox"]` | `input` | `searchbox` |
| `[role="textbox"]` | `input` | `textbox` |

When a native element and ARIA role conflict, ARIA role wins for `role`; native element tag determines `tag`.

---

## ID and Attribute Extraction

Capture these for use as `selector_hints` and scoring signals:

- `id` — if present and non-empty
- `aria-label` — if present
- `href` — for links; full URL is stored internally; only `href_path` is returned externally
- `data-testid` — if present (useful for stable resolution)
- `name` attribute — for form inputs

---

## Frame Handling

### v1: Main Frame Only

v1 operates on the main top-level frame. Cross-origin iframes and `<frame>` elements are excluded.

Same-origin iframes may be supported if implementation complexity is low — but this is optional for v1. Mark excluded iframe elements with a comment in the snapshot, not as errors.

### Future: Shadow DOM

Open shadow DOM roots can be traversed with `el.shadowRoot.querySelectorAll(...)` if `el.shadowRoot` is non-null. This is future scope. The extractor should have a `shadow_dom_traversal: false` placeholder for v1.

### Future: Cross-Origin iframes

Require a separate `Runtime.evaluate` call in the iframe's execution context. Each iframe would produce a separate snapshot segment. Out of scope for v1.

---

## Performance Constraints

- Default cap: **200 visible interactive elements** returned
- Hard cap: 500 (configurable by API parameter)
- Priority order within cap: viewport-visible elements first, sorted by DOM order
- Do not traverse the entire DOM tree. Use `querySelectorAll` on the candidate selector string and filter the result.
- The IIFE must complete within a reasonable budget (< 200ms). If extraction takes longer, log a warning and return whatever was collected so far.

---

## Caveats and Known Limitations

These must be documented to set accurate expectations:

| Limitation | Notes |
|------------|-------|
| Canvas elements | No accessible elements; Antigen Snapshot cannot see canvas-rendered UI |
| Cross-origin iframes | Not supported in v1 |
| Shadow DOM | Not supported in v1 |
| Virtualized lists | Only loaded/rendered items are visible in the DOM; off-screen items are not extracted |
| getBoundingClientRect vs. actual hit target | The box Chromium reports may differ from the actual hit-test result for overlapping elements |
| Layout shifts after extraction | Boxes can go stale after ads load, modals open, or sticky headers shift layout |
| Elements with `pointer-events: none` | Marked `enabled: false`; clicking will fail even if they look visible |
| Sites with bad accessibility | Elements may have empty or misleading accessible names; scoring falls back to href/id signals |
